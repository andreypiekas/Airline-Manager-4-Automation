#!/usr/bin/env node
'use strict';
// Safe cleanup of branches of already merged PRs, with exact HEAD-SHA verification.
// Defaults to DRY RUN. Never interacts with Airline Manager 4 or production state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const KEEP = new Set(['main','am4-runtime-state','migration-stable']);
const PREFIXES = ['fix/','feat/','feature/','docs/','diagnostic/','audit/','chore/'];
const args = process.argv.slice(2);
if(args.some(a=>!['--apply','--dry-run','--self-test'].includes(a)) ||
   (args.includes('--apply')&&args.includes('--dry-run')))
  throw Error('USAGE: node scripts/prune-merged-branches.cjs [--apply|--dry-run|--self-test]');

function eligible(branch,closed,openNames,repo){
  if(!branch?.name||!/^[a-zA-Z0-9._/-]+$/.test(branch.name)||
     !branch.commit?.sha||branch.protected||KEEP.has(branch.name)||
     openNames.has(branch.name)||!PREFIXES.some(p=>branch.name.startsWith(p)))
    return false;
  return closed.some(p=>p.merged_at &&
    p.head?.ref===branch.name && p.head?.sha===branch.commit.sha &&
    p.head?.repo?.full_name===repo && p.base?.repo?.full_name===repo);
}
function test(){
  const repo='owner/repo',branch={name:'fix/done',commit:{sha:'a1'},protected:false};
  const pr={merged_at:'2026-11-01T00:00:00Z',head:{ref:'fix/done',sha:'a1',repo:{full_name:repo}},base:{repo:{full_name:repo}}};
  assert(eligible(branch,[pr],new Set(),repo));
  assert(!eligible({...branch,commit:{sha:'changed'}},[pr],new Set(),repo));
  assert(!eligible({...branch,protected:true},[pr],new Set(),repo));
  assert(!eligible(branch,[pr],new Set(['fix/done']),repo));
  assert(!eligible(branch,[{...pr,merged_at:null}],new Set(),repo));
  assert(!eligible(branch,[{...pr,head:{...pr.head,repo:{full_name:'fork/repo'}}}],new Set(),repo));
  for(const name of [...KEEP,'snapshot/recovery'])
    assert(!eligible({...branch,name},[{...pr,head:{...pr.head,ref:name}}],new Set(),repo));
  console.log('[BranchPrune] self-test passed');
}
async function api(method,url,token,{allow404=false}={}){
  const response=await fetch('https://api.github.com'+url,{
    method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','User-Agent':'am4-branch-prune'}
  });
  if(allow404&&response.status===404)return null;
  if(!response.ok)throw Error('GITHUB_API_'+method+'_'+response.status);
  return response.status===204?true:response.json();
}
async function pages(repo,resource,token){
  const rows=[];
  for(let n=1;n<=20;n++){
    const sep=resource.includes('?')?'&':'?';
    const part=await api('GET','/repos/'+repo+'/'+resource+sep+'per_page=100&page='+n,token);
    if(!Array.isArray(part))throw Error('GITHUB_PAGINATION_UNEXPECTED_RESPONSE');
    rows.push(...part);
    if(part.length<100)return rows;
  }
  throw Error('GITHUB_PAGINATION_EXCEEDED');
}
function refPath(repo,name){
  return '/repos/'+repo+'/git/refs/heads/'+name.split('/').map(encodeURIComponent).join('/');
}
function summary(line){
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,line+'\n');
}
async function main(){
  if(args.includes('--self-test'))return test();
  const apply=args.includes('--apply');
  const repo=process.env.GITHUB_REPOSITORY||process.env.REPO_FULL_NAME;
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  if(!repo||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!token)
    throw Error('GITHUB_REPOSITORY_AND_TOKEN_REQUIRED');
  const [branches,closed,open]=await Promise.all([
    pages(repo,'branches',token),pages(repo,'pulls?state=closed',token),
    pages(repo,'pulls?state=open',token)
  ]);
  const openNames=new Set(open.filter(p=>p.head?.repo?.full_name===repo).map(p=>p.head.ref));
  const candidates=branches.filter(b=>eligible(b,closed,openNames,repo));
  if(candidates.length>150)throw Error('CANDIDATE_LIMIT_150_EXCEEDED');
  console.log('[BranchPrune] '+JSON.stringify({mode:apply?'APPLY':'DRY_RUN',branches:branches.length,
    eligible:candidates.length,openPRs:open.length,excluded:branches.length-candidates.length}));
  summary('### Limpeza segura de branches\n\nModo: **'+(apply?'APPLY':'DRY_RUN')+
    '**. Encontradas: **'+branches.length+'**. Elegíveis: **'+candidates.length+'**.');
  if(!apply){
    for(const b of candidates)console.log('[BranchPrune] DRY_RUN '+b.name);
    return;
  }
  let deleted=0,changed=0,failed=0;
  for(const b of candidates){
    const uri=refPath(repo,b.name);
    try{
      const current=await api('GET',uri,token,{allow404:true});
      if(!current||current.object?.sha!==b.commit.sha){
        changed++;console.warn('[BranchPrune] SKIP_CHANGED '+b.name);continue;
      }
      const result=await api('DELETE',uri,token,{allow404:true});
      if(result===null){changed++;continue;}
      deleted++;console.log('[BranchPrune] DELETED '+b.name);
    }catch(e){failed++;console.error('[BranchPrune] FAILED '+b.name+' '+(e?.message||'UNKNOWN'));}
  }
  console.log('[BranchPrune] '+JSON.stringify({deleted,changed,failed,preserved:branches.length-deleted}));
  summary('Excluídas: **'+deleted+'**. Alteradas/ausentes: **'+changed+
    '**. Erros: **'+failed+'**. Branches protegidas, estado persistente e PRs abertos preservados.');
  if(failed)process.exitCode=1;
}
main().catch(e=>{console.error('[BranchPrune] '+(e?.message||'UNKNOWN'));process.exitCode=1;});
