#!/usr/bin/env node
'use strict';
/**
 * One-time audited cleanup. By default this script NEVER deletes a ref.
 * Only native GitHub refs are touched; no game login, runtime journal or scripts.
 *
 * Eligibility:
 *  (1) exact head of a merged same-repo PR, OR
 *  (2) strict ancestor of the current main (ahead_by=0), OR
 *  (3) explicitly reviewed branch with exact pinned HEAD, listed below.
 * The main HEAD and each target SHA must remain unchanged before deletion.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const args=process.argv.slice(2);
const KEEP=new Set([
  'main','am4-runtime-state','migration-stable',
  'snapshot/rolling-dispatch-pr83-source-1035'
]);
const PREFIXES=['fix/','feat/','feature/','docs/','diagnostic/','audit/','chore/'];
const RETIRED_EXACT=Object.freeze({
  // PRs #90-#92: safety changes selectively reimplemented by merged PR #119.
  'fix/all-ready-details-timeout-green-1075-20261027':'4285a9c6432e112c8741827027db94222abb63bb',
  'fix/persist-state-after-cancelled-live-run-1081-20261027':'adf98b848fd9a4f8cae216eae3c54b6bf54ba5ba',
  'fix/run1127-unverifiable-demand-fail-closed':'897469b89d422dbb1b172e80be57d88004d5ac8b',
  // Reviewed and rejected: old fixed-SHA audit, unsafe maintenance fallback,
  // duplicate Telegram summary already superseded by PR #109.
  'audit/readonly-fleet-preview-20261021':'69f62bec21ee20463c6fa0e5c2f0eed50c1bcbad',
  'fix/maintenance-card-skip-fail-closed-705':'f64d14399314431708e1a18347d75249f709bc31',
  'fix/telegram-evidence-first-summary-1330':'0a56201d504a4a729d22d3d3475981bd7ad6773f'
});
if(args.some(x=>!['--apply','--dry-run','--self-test'].includes(x))||
   (args.includes('--apply')&&args.includes('--dry-run')))
  throw Error('USAGE: node scripts/retire-audited-branches.cjs [--dry-run|--apply|--self-test]');

function safeBase(b,openNames){
  return !!(b?.name&&/^[A-Za-z0-9._/-]+$/.test(b.name)&&
    /^[a-f0-9]{40}$/.test(b.commit?.sha||'') &&
    !b.protected && !KEEP.has(b.name) && !openNames.has(b.name) &&
    PREFIXES.some(prefix=>b.name.startsWith(prefix)));
}
function reviewedExact(b){
  return RETIRED_EXACT[b.name]===b.commit.sha;
}
function mergedExact(b,prs,repo){
  return prs.some(p=>p.merged_at && p.head?.ref===b.name &&
    p.head?.sha===b.commit.sha && p.head?.repo?.full_name===repo &&
    p.base?.repo?.full_name===repo);
}
function ancestorComparisonValid(d){
  return d?.status==='behind'&&d.ahead_by===0&&
    Number.isSafeInteger(d.behind_by)&&d.behind_by>0;
}
function selfTest(){
  const repo='example/repo';
  const b={name:'fix/old',commit:{sha:'a'.repeat(40)},protected:false};
  const p={merged_at:'2026-11-06',head:{ref:b.name,sha:b.commit.sha,repo:{full_name:repo}},
    base:{repo:{full_name:repo}}};
  assert(safeBase(b,new Set()));
  assert(!safeBase({...b,protected:true},new Set()));
  assert(!safeBase({...b,name:'am4-runtime-state'},new Set()));
  assert(!safeBase({...b,name:'migration-stable'},new Set()));
  assert(!safeBase({...b,name:'snapshot/rolling-dispatch-pr83-source-1035'},new Set()));
  assert(!safeBase(b,new Set([b.name])));
  assert(mergedExact(b,[p],repo));
  assert(!mergedExact({...b,commit:{sha:'b'.repeat(40)}},[p],repo));
  assert(!mergedExact(b,[{...p,merged_at:null}],repo));
  assert(!mergedExact(b,[{...p,head:{...p.head,repo:{full_name:'another/repo'}}}],repo));
  assert(ancestorComparisonValid({status:'behind',ahead_by:0,behind_by:3}));
  assert(!ancestorComparisonValid({status:'diverged',ahead_by:1,behind_by:3}));
  assert(!ancestorComparisonValid({status:'ahead',ahead_by:1,behind_by:0}));
  assert(!ancestorComparisonValid({status:'identical',ahead_by:0,behind_by:0}));
  const r={name:'fix/maintenance-card-skip-fail-closed-705',
    commit:{sha:RETIRED_EXACT['fix/maintenance-card-skip-fail-closed-705']}};
  assert(reviewedExact(r));
  assert(!reviewedExact({...r,commit:{sha:'a'.repeat(40)}}));
  console.log('[AuditedBranchCleanup] self-test passed');
}
async function api(method,endpoint,token,{allow404=false}={}){
  const r=await fetch('https://api.github.com'+endpoint,{method,headers:{
    Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','User-Agent':'am4-audited-cleanup'
  }});
  if(allow404&&r.status===404)return null;
  if(!r.ok)throw Error('GITHUB_API_'+method+'_'+r.status);
  return r.status===204?true:r.json();
}
async function pages(repo,path,token){
  const results=[];
  for(let i=1;i<=20;i++){
    const page=await api('GET','/repos/'+repo+'/'+path+
      (path.includes('?')?'&':'?')+'per_page=100&page='+i,token);
    if(!Array.isArray(page))throw Error('GITHUB_PAGINATION_UNEXPECTED_RESPONSE');
    results.push(...page);
    if(page.length<100)return results;
  }
  throw Error('GITHUB_PAGINATION_LIMIT');
}
function refPath(repo,name){
  return '/repos/'+repo+'/git/refs/heads/'+name.split('/').map(encodeURIComponent).join('/');
}
async function compare(repo,mainSha,branchSha,token){
  if(!/^[a-f0-9]{40}$/.test(mainSha)||!/^[a-f0-9]{40}$/.test(branchSha))
    throw Error('INVALID_COMPARE_SHA');
  return api('GET','/repos/'+repo+'/compare/'+mainSha+'...'+branchSha,token);
}
function summary(line){
  if(process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,line+'\n');
}
async function main(){
  if(args.includes('--self-test'))return selfTest();
  const repo=process.env.GITHUB_REPOSITORY||process.env.REPO_FULL_NAME;
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  const apply=args.includes('--apply');
  if(!repo||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!token)
    throw Error('GITHUB_REPOSITORY_AND_TOKEN_REQUIRED');
  const [head,branches,closed,open]=await Promise.all([
    api('GET',refPath(repo,'main'),token),
    pages(repo,'branches',token),
    pages(repo,'pulls?state=closed',token),
    pages(repo,'pulls?state=open',token)
  ]);
  const mainSha=head.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(mainSha||''))throw Error('MAIN_SHA_INVALID');
  const openNames=new Set(open.filter(p=>p.head?.repo?.full_name===repo)
    .map(p=>p.head.ref));
  const eligible=[];
  for(const b of branches){
    if(!safeBase(b,openNames))continue;
    let reason=null;
    if(reviewedExact(b))reason='REVIEWED_EXACT_SHA';
    else if(mergedExact(b,closed,repo))reason='MERGED_PR_EXACT_SHA';
    else {
      const result=await compare(repo,mainSha,b.commit.sha,token);
      if(ancestorComparisonValid(result))reason='STRICT_MAIN_ANCESTOR';
    }
    if(reason)eligible.push({branch:b,reason});
  }
  if(eligible.length>50)throw Error('AUDITED_CANDIDATE_LIMIT_50_EXCEEDED');
  console.log('[AuditedBranchCleanup] '+JSON.stringify({
    mode:apply?'APPLY':'DRY_RUN',branchCount:branches.length,candidates:eligible.length,
    openPRs:open.length,mainSha:mainSha.slice(0,12)
  }));
  summary('### Limpeza auditada de branches\n\nModo: **'+(apply?'APPLY':'DRY_RUN')+
    '**. Total: **'+branches.length+'**, candidatas: **'+eligible.length+'**.');
  if(!apply){
    for(const {branch,reason} of eligible)
      console.log('[AuditedBranchCleanup] DRY_RUN '+reason+' '+branch.name);
    return;
  }
  let deleted=0,changed=0,failed=0;
  for(const {branch,reason} of eligible){
    try{
      const latestMain=await api('GET',refPath(repo,'main'),token);
      if(latestMain.object?.sha!==mainSha)
        throw Error('MAIN_MOVED_STOP_TO_REAUDIT');
      const uri=refPath(repo,branch.name);
      const latest=await api('GET',uri,token,{allow404:true});
      if(!latest||latest.object?.sha!==branch.commit.sha){
        changed++;console.warn('[AuditedBranchCleanup] SKIP_CHANGED '+branch.name);continue;
      }
      if(reason==='STRICT_MAIN_ANCESTOR' &&
         !ancestorComparisonValid(await compare(repo,mainSha,branch.commit.sha,token))){
        changed++;console.warn('[AuditedBranchCleanup] SKIP_NOT_ANCESTOR '+branch.name);
        continue;
      }
      if(reason==='REVIEWED_EXACT_SHA'&&!reviewedExact(branch))
        throw Error('REVIEWED_SHA_MISMATCH_STOP');
      const result=await api('DELETE',uri,token,{allow404:true});
      if(result===null){changed++;continue;}
      deleted++;console.log('[AuditedBranchCleanup] DELETED '+reason+' '+branch.name);
    }catch(e){
      failed++;console.error('[AuditedBranchCleanup] FAILED '+branch.name+' '+String(e?.message||'UNKNOWN'));
      if(e?.message==='MAIN_MOVED_STOP_TO_REAUDIT')break;
    }
  }
  const report={deleted,changed,failed,preserved:branches.length-deleted};
  console.log('[AuditedBranchCleanup] '+JSON.stringify(report));
  summary('Excluídas: **'+deleted+'**; alteradas: **'+changed+
    '**; falhas: **'+failed+'**; restantes: **'+(branches.length-deleted)+
    '**. main, estado operacional, marco de migração e snapshot preservados.');
  if(failed)process.exitCode=1;
}
main().catch(e=>{console.error('[AuditedBranchCleanup] '+String(e?.message||'UNKNOWN'));process.exitCode=1;});
