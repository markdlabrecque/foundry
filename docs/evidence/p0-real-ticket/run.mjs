// Manual, bounded real-subscription acceptance journey. Not part of the commit test suite.
// No stage output is scripted: only configured instructions and an operator ticket are supplied.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const repo = process.cwd();
const root = mkdtempSync(join(homedir(), '.f135-'));
const out = resolve(process.argv[2] || 'docs/evidence/p0-real-ticket/run');
mkdirSync(out, {recursive:true,mode:0o700});
const home = join(root,'state');
const provider = join(homedir(),'.pi/agent/extensions/pi-claude-subscription/index.ts');
const env = Object.fromEntries(['HOME','PATH','LANG','TERM','SHELL','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
Object.assign(env,{TMPDIR:join(root,'tmp'),PI_CODING_AGENT_DIR:join(root,'agent'),PI_TELEMETRY:'0',PI_CLAUDE_SUBSCRIPTION_SESSION_MODE:'replay',PI_CLAUDE_SUBSCRIPTION_AUDIT:'0',PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK:'0',FOUNDRY_WORKER_RUNTIME:'sdk',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_AUTHOR_NAME:'Disposable FOU135',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Disposable FOU135',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_TERMINAL_PROMPT:'0'});
for(const dir of ['tmp','agent','repo','roles'])mkdirSync(join(root,dir),{recursive:true});
const journal=[];
const save=(name,value)=>writeFileSync(join(out,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const command=(bin,args,cwd=repo)=>{const entry={time:new Date().toISOString(),bin,args,cwd};journal.push(entry);try{const stdout=execFileSync(bin,args,{cwd,env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});entry.exit=0;entry.stdout=stdout;return stdout;}catch(e){entry.exit=e.status;entry.stdout=e.stdout?.toString();entry.stderr=e.stderr?.toString();throw e;}finally{save('commands.json',journal);}};
const git=(cwd,...args)=>command('git',args,cwd).trim();
const cli=(...args)=>JSON.parse(command(process.execPath,[join(repo,'packages/cli/dist/main.js'),...args,'--home',home,'--json']));
const files=(dir)=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]):[];
let daemon,stdout='',stderr='',result={verdict:'inconclusive',root,product:git(repo,'rev-parse','HEAD'),startedAt:new Date().toISOString(),model:'pi-claude-subscription/claude-sonnet-5-5',requestBound:50,wallBoundSeconds:900};
try{
  command('claude',['--version']);
  // Auth status output is deliberately discarded, never retained.
  execFileSync('claude',['auth','status'],{env,stdio:'ignore',timeout:10000}); result.authAvailable=true;
  git(join(root,'repo'),'init','-b','main');
  writeFileSync(join(root,'repo/package.json'),'{"type":"module","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(root,'repo/clamp.mjs'),'export function clamp(value, min, max) {\n  return value;\n}\n');
  git(join(root,'repo'),'add','.');git(join(root,'repo'),'commit','--no-gpg-sign','-m','Disposable baseline');
  result.initialCommit=git(join(root,'repo'),'rev-parse','HEAD');
  const common=`One authorized tiny disposable acceptance ticket. Work only within ${root}. Do not read credentials, auth files, environment secrets, operator HOME files or other repositories. Do not use network, git push/fetch, logins, paid keys or external agents. Do not modify global configuration or cache. No subagents. All inter-agent communication must use Foundry agent_message/agent_request, never file inboxes, terminal injection or another agent's session/private reasoning. Ordinary specification, repository and stage evidence artifacts are shared contract material. Use only the provided tools. Wait silently for assignments; prime alone is not work. Never write the knowledge root. Disable git hooks for any commit via git -c core.hooksPath=/dev/null. Budget: at most 10 model responses per stage; one attempt, no retry after a failed test or tool/provider failure. On a reproducible failure report blocked with genuine evidence.\nWhen assigned, read Specification path and follow your role. Write a concise independent stage report under Evidence path named STAGE.md. Use task_transition with the actual assignmentId, outcome, reason, evidence array; stages on code require gitCommit of actual HEAD. Do not fabricate outputs. Do not assume prior worker claims are correct.\n`;
  writeFileSync(join(root,'roles/common.md'),common);
  const roles={
    specify:'Read the submitted request and refine its Specification file into objective, exact requirements, non-goals, acceptance criteria and cheap verification plan. Do not write repository code. Save specify.md as your actual specification-stage report then task_transition done (no gitCommit needed).',
    implement:'Implement the specification in the assigned worktree only. Add cheap pure node:test cases proving the specified behavior. Run npm test and record genuine output. Commit code and tests only, no evidence in git. Write implement.md with actual commit, changed paths and test output. Send a concise public handoff using agent_message to eng.review with delivery after_turn; no private reasoning. Report done with gitCommit.',
    review:'Independently review the specification and actual git diff from baseline to HEAD, read the source and tests, and run npm test yourself. Do not read implementer session/private analysis. Do not change branch or tracked files. Write review.md recording actual findings, exact evaluated commit and observed test results. Send a channel-only public review summary to eng.verify. Reject/blocked if requirements unmet; otherwise done with gitCommit.',
    verify:'Independently verify requirements against code and run npm test. Do not change branch or tracked files. Check the public specify/review evidence. Trial-merge main into an owned temporary worktree under the disposable root (git worktree add --detach, merge --no-commit --no-ff, npm test, abort if needed, remove clean scratch). Do not write the factory main branch. Write verify.md with observed output, exact commit, integration summary and operator recommendation. Then done with gitCommit to request CLI operator approval. Never approve yourself.'};
  for(const [name,text] of Object.entries(roles))writeFileSync(join(root,`roles/${name}.md`),text+'\n');
  const yaml=`version: 1\nname: realticket\nrepository:\n  source: ./repo\n  default_branch: main\ndefault_production_line: tiny\nworktrees:\n  root: ${root}/worktrees\nmessage_budget: 12\nrecovery_limit: 1\ndefaults:\n  instructions: roles/common.md\n  model: ${result.model}\n  extensions: [${JSON.stringify(provider)}]\nrooms:\n  eng:\n    stations:\n${Object.keys(roles).map(s=>`      ${s}:\n        isolation: ${s==='specify'?'none':'worktree'}\n        instructions: roles/${s}.md`).join('\n')}\nproduction_lines:\n  tiny:\n    rejection_limit: 1\n    verify: [npm, test]\n    stages:\n      - id: specify\n        station: eng.specify\n      - id: implement\n        station: eng.implement\n        writing: true\n      - id: review\n        station: eng.review\n        on_rejection: implement\n      - id: verify\n        station: eng.verify\n        approval: true\n        on_rejection: implement\n`;
  writeFileSync(join(root,'factory.yaml'),yaml);save('factory.yaml',yaml);
  writeFileSync(join(root,'request.md'),'# Clamp a finite number\nFix clamp(value,min,max) in clamp.mjs. Inputs are finite numbers and min <= max (validation out of scope). Return min below the lower bound, max above the upper bound, and the unchanged value within or equal to either bound. Preserve negative and fractional numbers. Add cheap pure tests using node:test covering below, above, inside, equality at each bound, negative and fractional values, and min=max. No dependencies or unrelated features. npm test must pass.\n');
  command(process.execPath,[join(repo,'packages/cli/dist/main.js'),'validate',join(root,'factory.yaml')]);
  const argv=[join(repo,'packages/daemon/dist/main.js'),'--home',home,join(root,'factory.yaml')];
  result.daemonArgv=[process.execPath,...argv];
  daemon=spawn(process.execPath,argv,{cwd:repo,env,stdio:['ignore','pipe','pipe']});result.daemonPid=daemon.pid;
  daemon.stdout.on('data',b=>{stdout+=b;save('daemon.stdout.log',stdout);});daemon.stderr.on('data',b=>{stderr+=b;save('daemon.stderr.log',stderr);});
  const deadline=Date.now()+900000;
  while(!stdout.includes('management API on')){if(daemon.exitCode!==null)throw Error('daemon startup exit');if(Date.now()>deadline)throw Error('startup deadline');await delay(100);}
  save('initial-status.json',cli('status'));save('initial-slots.json',cli('slot','list'));
  save('submitted.json',cli('ticket','submit',join(root,'request.md')));
  let waiting;
  while(Date.now()<deadline){
    const detail=cli('ticket','show','1').result; save('latest-ticket.json',detail);
    const sessions=files(home).filter(p=>p.includes('/sessions/')&&p.endsWith('.jsonl'));
    const messages=sessions.flatMap(p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l))).filter(e=>e.type==='message'&&e.message?.role==='assistant');
    result.assistantResponses=messages.length;
    const failure=messages.find(e=>e.message.stopReason==='error'||e.message.stopReason==='aborted');
    if(failure){save('first-model-failure.json',failure);throw Error('First actual model/provider error; no retry');}
    if(messages.length>50)throw Error('model response budget exceeded');
    if(detail.transitions.some(t=>t.outcome==='rejected'||t.outcome==='blocked'))throw Error('First rejected/blocked stage outcome; no retry');
    if(detail.ticket.status==='paused')throw Error('ticket paused');
    if(detail.ticket.status==='awaiting_approval'){waiting=detail;break;}
    await delay(1500);
  }
  if(!waiting)throw Error('bounded journey deadline');
  save('awaiting-approval.json',waiting);
  const clone=cli('factory','path','realticket').result;
  result.factoryPathResult=clone;
  // Product path is stable and confirmed independently through CLI output above.
  const clonePath=clone.path;
  result.preApprovalHead=git(clonePath,'rev-parse','main');
  if(result.preApprovalHead!==result.initialCommit)throw Error('default branch moved before approval');
  const approvals=cli('approval','list');save('approvals.json',approvals);
  const a=approvals.result.approvals.find(a=>a.kind==='stage_gate'&&a.state==='open');
  if(!a)throw Error('missing CLI approval gate');save('approval-show.json',cli('approval','show',String(a.id)));
  result.approvedCommit=a.commit;
  save('approval-decision.json',cli('approval','approve',String(a.id)));
  while(Date.now()<deadline){const d=cli('ticket','show','1').result;save('latest-ticket.json',d);if(d.ticket.state==='completed'){result.completed=true;break;}if(d.ticket.status==='paused'||d.transitions.some(t=>t.outcome==='rejected'))throw Error('integration failed');await delay(300);}
  if(!result.completed)throw Error('integration deadline');
  result.landedCommit=git(clonePath,'rev-parse','main');
  save('landed.diff',git(clonePath,'diff',result.initialCommit,result.landedCommit)+'\n');
  save('landed-commit.txt',git(clonePath,'show','--format=fuller','--stat',result.landedCommit)+'\n');
  save('landed-test.log',command('npm',['test'],clonePath));
  result.sourceHead=git(join(root,'repo'),'rev-parse','main');result.cloneStatus=git(clonePath,'status','--porcelain');
  save('final-worktrees.json',cli('worktree','list'));save('final-slots.json',cli('slot','list'));save('events.json',cli('events','--factory','realticket','--ticket','1'));
  result.verdict=result.landedCommit===result.approvedCommit&&result.sourceHead===result.initialCommit&&result.cloneStatus===''?'supported':'inconclusive';
}catch(e){result.failure=String(e);result.verdict='blocked';}
finally{
  result.finishedAt=new Date().toISOString();
  try{save('shutdown.json',cli('shutdown'));}catch(e){result.shutdownError=String(e);}
  await delay(1500);
  result.daemonExit=daemon?.exitCode;
  // Retain only disposable known outputs, never operator configuration/auth files.
  for(const f of files(home))if((f.includes('/sessions/')&&f.endsWith('.jsonl'))||f.includes('/evidence/')||f.endsWith('/spec.md')||f.endsWith('.log')||f.endsWith('.sqlite')||f.endsWith('.db')||f.endsWith('host.json')){const target=join(out,'state',f.slice(home.length+1));mkdirSync(resolve(target,'..'),{recursive:true});cpSync(f,target);}
  for(const f of files(join(root,'roles'))){mkdirSync(join(out,'roles'),{recursive:true});cpSync(f,join(out,'roles',f.split('/').at(-1)));}
  save('result.json',result);
  // Root retained until process ownership/cleanup is independently inspected.
  console.log(JSON.stringify(result,null,2));
}
