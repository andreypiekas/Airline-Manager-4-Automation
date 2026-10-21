import type { ExecutionEntry } from './executor';
import { appendConfirmedDepartures, appendUncertainDepartures } from '../optimization/return-journal';

/**
 * Flush confirmed/uncertain terminal results as soon as the executor writes
 * each post-click checkpoint, not only once the whole fleet has been visited.
 * Only already-confirmed outcomes are journaled; this never authorizes a click.
 */
export class DepartureTerminalCheckpoints {
  private readonly confirmed = new Set<string>();
  private readonly uncertain = new Set<string>();
  constructor(private readonly directory:string,private readonly scope:string,private readonly runId:string){}
  async flush(entries:ReadonlyArray<ExecutionEntry>):Promise<{departed:number;uncertain:number}>{
    const key=(e:ExecutionEntry)=>e.aircraftId+':'+e.routeId;
    const departed=entries.filter(e=>e.status==='departed'&&!this.confirmed.has(key(e)));
    if(departed.length){
      const persisted=await appendConfirmedDepartures(this.directory,this.scope,this.runId,{entries:departed});
      if(persisted!==departed.length)throw Error('DEPARTURE_CHECKPOINT_INCOMPLETE');
      departed.forEach(e=>this.confirmed.add(key(e)));
    }
    const uncertain=entries.filter(e=>e.status==='outcome_unknown'&&!this.uncertain.has(key(e)));
    if(uncertain.length){
      const persisted=await appendUncertainDepartures(this.directory,this.scope,this.runId,{entries:uncertain});
      if(persisted!==uncertain.length)throw Error('DEPARTURE_UNCERTAIN_CHECKPOINT_INCOMPLETE');
      uncertain.forEach(e=>this.uncertain.add(key(e)));
    }
    return {departed:departed.length,uncertain:uncertain.length};
  }
}
