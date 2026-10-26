import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateReturnJournal } from './return-journal';

const BRANCH = 'am4-runtime-state';
const MAX_BYTES = 900000; // Contents API full JSON response is limited to files <= 1 MB.
const TRANSPORT_HISTORY_LIMITS = {
  reviewEntriesPerAircraftOrigin: 4,
  // Recent confirmed history is advisory evidence; retain six cycles per aircraft.
  // Uncertain mutations and their resolutions remain unbounded and untouched.
  departuresPerAircraft: 6,
  flightHistoryAnchorsPerAircraft: 3,
  supplyObservationsPerKind: 48,
  holdObservationsPerAircraft: 12,
  uiHealthObservations: 48
} as const;

const tailPerKey = <T>(items: readonly T[], limit: number, keyOf: (item: T) => string): T[] => {
  const counts = new Map<string, number>(), keep = new Set<number>();
  for (let i = items.length - 1; i >= 0; i--) {
    const key = keyOf(items[i]), count = counts.get(key) || 0;
    if (count >= limit) continue;
    counts.set(key, count + 1); keep.add(i);
  }
  return items.filter((_, i) => keep.has(i));
};

/**
 * Bounds transport growth without weakening safety state.
 *
 * Safety-critical uncertain mutation events and their resolution records are
 * always preserved. Historical observations are intentionally bounded because
 * their consumers need only recent evidence; losing older observations merely
 * falls back to conservative/default behavior.
 */
export function compactReturnJournalForTransport(journal: any, limits: typeof TRANSPORT_HISTORY_LIMITS = TRANSPORT_HISTORY_LIMITS): any {
  const compacted = { ...journal };

  compacted.entries = tailPerKey(
    Array.isArray(journal.entries) ? journal.entries : [],
    limits.reviewEntriesPerAircraftOrigin,
    (e: any) => String(e?.aircraftId || '') + ':' + String(e?.origin || '')
  );

  if (Array.isArray(journal.events)) {
    const departures = tailPerKey(
      journal.events.filter((e: any) => e?.type === 'departure'),
      limits.departuresPerAircraft,
      (e: any) => String(e?.aircraftId || '')
    );
    const departureIds = new Set(departures.map((e: any) => e.eventId));
    const anchors = tailPerKey(
      journal.events.filter((e: any) => e?.type === 'flight-history-anchor'),
      limits.flightHistoryAnchorsPerAircraft,
      (e: any) => String(e?.aircraftId || '')
    );
    const arrivals = journal.events.filter(
      (e: any) => e?.type === 'arrival-observed' && departureIds.has(e.departureEventId)
    );
    // Deferred-priority observations are scheduling hints, not safety
    // evidence. Keep only the most recent state per aircraft/route to prevent
    // unbounded state growth, including 'rechecked' tombstones.
    const deferred = tailPerKey(
      journal.events.filter((e: any) => e?.type === 'dispatch-deferred' || e?.type === 'dispatch-deferred-rechecked')
        .sort((a: any,b: any) => Date.parse(a.observedAt)-Date.parse(b.observedAt) ||
          String(a.eventId).localeCompare(String(b.eventId))),
      1,(e: any) => String(e?.aircraftId || '') + ':' + String(e?.routeId || '')
    );
    const safetyEvents = journal.events.filter(
      (e: any) => !['departure', 'arrival-observed', 'flight-history-anchor',
        'dispatch-deferred', 'dispatch-deferred-rechecked'].includes(e?.type)
    );
    const retained = new Set(
      [...departures, ...anchors, ...arrivals, ...deferred, ...safetyEvents].map((e: any) => e.eventId)
    );
    compacted.events = journal.events.filter((e: any) => retained.has(e.eventId));
  }

  if (Array.isArray(journal.supplyObservations)) compacted.supplyObservations = tailPerKey(
    journal.supplyObservations,
    limits.supplyObservationsPerKind,
    (e: any) => String(e?.kind || '')
  );
  if (Array.isArray(journal.holdObservations)) compacted.holdObservations = tailPerKey(
    journal.holdObservations,
    limits.holdObservationsPerAircraft,
    (e: any) => String(e?.aircraftId || '')
  );
  if (Array.isArray(journal.uiHealthObservations)) compacted.uiHealthObservations =
    journal.uiHealthObservations.slice(-limits.uiHealthObservations);

  return compacted;
}
/**
 * Preserve the usual six-cycle advisory history while it fits. When a large
 * fleet reaches the GitHub Contents transport ceiling, progressively discard
 * ONLY old advisory observations. Never remove uncertain mutations or their
 * resolutions, and never claim an oversized safety journal was persisted.
 */
export function compactReturnJournalToBudget(journal: any): any {
  const profiles = [
    TRANSPORT_HISTORY_LIMITS,
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 5 },
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 4 },
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 3, flightHistoryAnchorsPerAircraft: 2, reviewEntriesPerAircraftOrigin: 3, holdObservationsPerAircraft: 8, supplyObservationsPerKind: 32, uiHealthObservations: 32 },
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 2, flightHistoryAnchorsPerAircraft: 1, reviewEntriesPerAircraftOrigin: 2, holdObservationsPerAircraft: 4, supplyObservationsPerKind: 16, uiHealthObservations: 16 },
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 1, flightHistoryAnchorsPerAircraft: 1, reviewEntriesPerAircraftOrigin: 1, holdObservationsPerAircraft: 2, supplyObservationsPerKind: 8, uiHealthObservations: 8 },
    { ...TRANSPORT_HISTORY_LIMITS, departuresPerAircraft: 0, flightHistoryAnchorsPerAircraft: 0, reviewEntriesPerAircraftOrigin: 0, holdObservationsPerAircraft: 0, supplyObservationsPerKind: 0, uiHealthObservations: 0 }
  ];
  for (const profile of profiles) {
    const compacted = compactReturnJournalForTransport(journal, profile);
    if (Buffer.byteLength(JSON.stringify(compacted) + '\n') <= MAX_BYTES) return compacted;
  }
  throw new Error('STATE_TOO_LARGE');
}
export interface StateOptions { repository: string; scope: string; directory: string; token: string }
type Fetcher = typeof fetch;
const canonical = (v: unknown) => JSON.stringify(v);
/** Only state files on a fixed dedicated branch. Never writes main, workflows or game endpoints. */
export class GitHubReturnState {
  private readonly path: string;
  constructor(private readonly options: StateOptions, private readonly request: Fetcher = fetch) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.repository) || !/^[A-Za-z0-9_-]{1,100}$/.test(options.scope) || !options.token || !options.directory) throw new Error('STATE_CONFIG_INVALID');
    this.path = `/repos/${options.repository}/contents/return-journal-${options.scope}.json`;
  }
  private async raw(path: string, method: string, body?: object): Promise<Response> {
    try {
      return await this.request('https://api.github.com' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.options.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch {
      throw new Error('STATE_NETWORK_FAILED');
    }
  }
  private async api(method: string, body?: object): Promise<any> {
    const response = await this.raw(this.path + (method === 'GET' ? `?ref=${BRANCH}` : ''), method, body);
    if (!response.ok) throw new Error(`STATE_HTTP_${response.status}`);
    return await response.json();
  }
  private parse(text: string, enforceTransportLimit = true) {
    if (enforceTransportLimit && Buffer.byteLength(text) > MAX_BYTES) throw new Error('STATE_TOO_LARGE');
    try { return validateReturnJournal(JSON.parse(text), this.options.scope, new Date()); }
    catch { throw new Error('STATE_INVALID'); }
  }
  /** Ensures a fresh fork has its own state branch and journal without copying upstream runtime state. */
  async ensureInitialized(defaultBranch = 'main'): Promise<'existing' | 'initialized'> {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(defaultBranch) || defaultBranch.includes('..')) throw new Error('STATE_DEFAULT_BRANCH_INVALID');
    const existing = await this.raw(this.path + `?ref=${BRANCH}`, 'GET');
    if (existing.ok) return 'existing';
    if (existing.status !== 404) throw new Error(`STATE_HTTP_${existing.status}`);

    const repoBase = `/repos/${this.options.repository}`;
    const baseRef = await this.raw(`${repoBase}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, 'GET');
    if (!baseRef.ok) throw new Error(`STATE_HTTP_${baseRef.status}`);
    let baseSha: string;
    try {
      const body = await baseRef.json();
      baseSha = body?.object?.sha;
    } catch {
      throw new Error('STATE_RESPONSE_INVALID');
    }
    if (!/^[a-f0-9]{40}$/.test(baseSha!)) throw new Error('STATE_RESPONSE_INVALID');

    const createRef = await this.raw(`${repoBase}/git/refs`, 'POST', { ref: `refs/heads/${BRANCH}`, sha: baseSha! });
    if (!createRef.ok && createRef.status !== 422) throw new Error(`STATE_HTTP_${createRef.status}`);

    const content = JSON.stringify({ schemaVersion: 1, scope: this.options.scope, entries: [] }) + '\n';
    const createFile = await this.raw(this.path, 'PUT', {
      branch: BRANCH,
      message: 'chore: initialize return journal [skip ci]',
      content: Buffer.from(content).toString('base64')
    });
    if (createFile.ok) return 'initialized';
    if (createFile.status === 422) {
      const raced = await this.raw(this.path + `?ref=${BRANCH}`, 'GET');
      if (raced.ok) return 'existing';
    }
    throw new Error(`STATE_HTTP_${createFile.status}`);
  }

  /** Explicit one-time initialization; branch must already exist. Never invoked by the bot workflow. */
  async initialize(): Promise<void> {
    const content = JSON.stringify({ schemaVersion: 1, scope: this.options.scope, entries: [] }) + '\n';
    await this.api('PUT', { branch: BRANCH, message: 'chore: initialize return journal [skip ci]', content: Buffer.from(content).toString('base64') });
  }
  async restore(): Promise<void> {
    const directory = this.options.directory;
    // Refuse to overwrite local uncommitted state. Fresh Actions runners start without this directory.
    try { await stat(directory); throw new Error('STATE_LOCAL_EXISTS'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const response = await this.api('GET'); // 404 is a blocker, never an empty/new journal.
    if (response.type !== 'file' || response.encoding !== 'base64' || typeof response.content !== 'string' || !/^[a-f0-9]{40}$/.test(response.sha) || response.size > MAX_BYTES) throw new Error('STATE_RESPONSE_INVALID');
    const text = Buffer.from(response.content, 'base64').toString('utf8');
    const data = this.parse(text);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'return-journal.json'), JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'restored.json'), JSON.stringify({ repository: this.options.repository, scope: this.options.scope, branch: BRANCH, sha: response.sha, original: data }), { flag: 'wx', mode: 0o600 });
  }
  private async readRemoteState():Promise<{sha:string;data:any}>{
    const response=await this.api('GET');
    if(response.type!=='file'||response.encoding!=='base64'||typeof response.content!=='string'||!/^[a-f0-9]{40}$/.test(response.sha)||response.size>MAX_BYTES)
      throw new Error('STATE_RESPONSE_INVALID');
    return {sha:response.sha,data:this.parse(Buffer.from(response.content,'base64').toString('utf8'))};
  }
  private mergeAppendOnly(base:any,local:any,remote:any){
    const arrays=['entries','events','supplyObservations','holdObservations','uiHealthObservations'] as const;
    const merged={...remote};
    for(const key of arrays){
      const b=base[key]||[],l=local[key]||[],r=remote[key]||[];
      const samePrefix=(x:any[],prefix:any[])=>x.length>=prefix.length&&prefix.every((e,i)=>canonical(e)===canonical(x[i]));
      if(!samePrefix(l,b)||!samePrefix(r,b))throw new Error('STATE_CONFLICT_NON_APPEND_ONLY');
      const seen=new Set(r.map((e:any)=>canonical(e)));
      const extras=l.slice(b.length).filter((e:any)=>!seen.has(canonical(e)));
      merged[key]=[...r,...extras];
    }
    return this.parse(canonical(merged), false);
  }
  async save(): Promise<'unchanged' | 'saved'> {
    const baseline = JSON.parse(await readFile(join(this.options.directory, 'restored.json'), 'utf8'));
    if (baseline.repository !== this.options.repository || baseline.scope !== this.options.scope || baseline.branch !== BRANCH || !/^[a-f0-9]{40}$/.test(baseline.sha)) throw new Error('STATE_BASELINE_INVALID');
    const original = this.parse(canonical(baseline.original));
    // Local writers intentionally use pretty JSON for diagnostics. The GitHub Contents API
    // limit applies to the compact payload that is actually transported, not to whitespace
    // in the runner's local file.
    const current = this.parse(await readFile(join(this.options.directory, 'return-journal.json'), 'utf8'), false);
    const prefix=(before:unknown[]|undefined,after:unknown[]|undefined)=>{const a=before||[],b=after||[];return b.length>=a.length&&a.every((e,i)=>canonical(e)===canonical(b[i]));};
    if (!prefix(original.entries,current.entries)||!prefix(original.events,current.events)||!prefix(original.supplyObservations,current.supplyObservations)||!prefix(original.holdObservations,current.holdObservations)||!prefix(original.uiHealthObservations,current.uiHealthObservations)) throw new Error('STATE_NOT_APPEND_ONLY');
    const originalEvents=original.events||[],currentEvents=current.events||[];
    if(currentEvents.length<originalEvents.length||originalEvents.some((e,i)=>canonical(e)!==canonical(currentEvents[i])))throw new Error('STATE_NOT_APPEND_ONLY');
    const compacted = this.parse(canonical(compactReturnJournalToBudget(current)));
    if (canonical(original) === canonical(current) && canonical(compacted) === canonical(current)) return 'unchanged';
    const content = JSON.stringify(compacted) + '\n';
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('STATE_TOO_LARGE');
    // SHA is mandatory: never overwrite unseen remote changes.
    try{
      await this.api('PUT', { branch: BRANCH, sha: baseline.sha, message: 'chore: persist compacted return journal [skip ci]', content: Buffer.from(content).toString('base64') });
      return 'saved';
    }catch(error){
      if((error as Error)?.message!=='STATE_HTTP_409')throw error;
      // One bounded reconciliation retry is safe because both sides must still be strict append-only extensions of the restored baseline.
      const remote=await this.readRemoteState();
      const merged=this.mergeAppendOnly(original,current,remote.data);
      const compactedMerged=this.parse(canonical(compactReturnJournalToBudget(merged)));
      const mergedContent=JSON.stringify(compactedMerged)+'\n';
      if(Buffer.byteLength(mergedContent)>MAX_BYTES)throw new Error('STATE_TOO_LARGE');
      await this.api('PUT',{branch:BRANCH,sha:remote.sha,message:'chore: reconcile compacted return journal [skip ci]',content:Buffer.from(mergedContent).toString('base64')});
      return 'saved';
    }
  }
}
if (require.main === module) {
  (async () => {
    const client = new GitHubReturnState({ repository: process.env.GITHUB_REPOSITORY || '', token: process.env.GITHUB_TOKEN || '', scope: process.env.RETURN_JOURNAL_SCOPE || '', directory: '.am4-state/github' });
    const command = process.argv[2];
    if (command === 'restore') await client.restore();
    else if (command === 'save') await client.save();
    else if (command === 'ensure') await client.ensureInitialized(process.env.GITHUB_REF_NAME || 'main');
    else if (command === 'initialize') await client.initialize();
    else throw new Error('STATE_COMMAND_INVALID');
    console.log('[State] Operacao concluida.');
  })().catch((error) => {
    const code=(error as Error)?.message;
    const safe=/^STATE_[A-Z0-9_]+$/.test(code||'')?code:'STATE_UNCLASSIFIED';
    console.error('[State] Falha de persistencia: '+safe+'. Nenhum segredo foi registrado.');
    process.exitCode = 1;
  });
}
