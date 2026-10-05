const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');
const path = require('node:path');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const output = process.env.PROXY_TEST_RESULT;
const proxyUrl = process.env.PROXY_TEST_URL;
const userData = process.env.PROXY_TEST_USER_DATA;
if (!output || !proxyUrl || !userData) throw new Error('Use scripts/run-local-proxy-vscode.sh.');
exports.run = async function () {
  const checks = [];
  const details = [];
  try {
    const ext = vscode.extensions.getExtension('jorsm.vertex-ai-models-chat-provider');
    assert.ok(ext); await ext.activate();
    checks.push('actual bundled development extension activated');
    const config = vscode.workspace.getConfiguration('vertexAiChat');
    assert.equal(config.get('proxyUrl'), proxyUrl);
    assert.ok(config.get('projectId'), 'projectId is required even in proxy mode');
    await vscode.commands.executeCommand('vertexAiChat.refreshModels');
    const models = await vscode.lm.selectChatModels({vendor:'google-vertex'});
    details.push({models:models.map(m=>({id:m.id,name:m.name,vendor:m.vendor,family:m.family,maxInputTokens:m.maxInputTokens}))});
    await fs.writeFile(output, JSON.stringify({running:true,checks,details},null,2));
    assert.ok(models.some(m=>m.family==='gemini') && models.some(m=>m.family==='claude'), 'the configured server catalog must offer Gemini and Claude');

    checks.push('actual model picker exposes complete server catalog, including IDs absent locally');
    for (const model of [models.find(m=>m.family==='gemini'), models.find(m=>m.family==='claude')]) {
      const cancellation = new vscode.CancellationTokenSource();
      const timer = setTimeout(()=>cancellation.cancel(),60_000);
      let text = '', parts = 0;
      const started = Date.now();
      try {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('Reply with only the word OK.')],{},cancellation.token);
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) { text += part.value; parts++; }
        }
        assert.ok(text.trim(), model.id + ' returned text');
        details.push({id:model.id,text,parts,durationMs:Date.now()-started});
        checks.push(model.id + ': public VS Code sendRequest streamed through Docker to real Vertex');
        await fs.writeFile(output,JSON.stringify({running:true,checks,details},null,2));
      } finally { clearTimeout(timer); cancellation.dispose(); }
    }

    for (const model of [models.find(m=>m.family==='gemini'), models.find(m=>m.family==='claude')]) {
      const tools = [{name:'proxy_probe', description:'Returns a fixed test result. You must call it.', inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value']}}];
      const user = vscode.LanguageModelChatMessage.User('Call proxy_probe with value 42. Do not answer before calling it.');
      const firstResponse = await model.sendRequest([user],{tools,toolMode:vscode.LanguageModelChatToolMode.Required});
      const firstParts = [];
      for await (const part of firstResponse.stream) if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart) firstParts.push(part);
      const call = firstParts.find(p=>p instanceof vscode.LanguageModelToolCallPart);
      assert.ok(call, model.id+' requested the test tool');
      assert.equal(call.name,'proxy_probe');
      const assistant = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, firstParts);
      const toolResult = new vscode.LanguageModelToolResultPart(call.callId,[new vscode.LanguageModelTextPart('{"value":42,"result":"PROXY_TOOL_OK"}')]);
      const resultMessage = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User,[toolResult]);
      const finalResponse = await model.sendRequest([user,assistant,resultMessage,vscode.LanguageModelChatMessage.User('Now reply exactly PROXY_TOOL_OK.')],{tools});
      let text='';
      for await (const part of finalResponse.stream) if (part instanceof vscode.LanguageModelTextPart) text+=part.value;
      assert.match(text,/PROXY_TOOL_OK/);
      checks.push(model.id+': native tool call and signed continuation accepted by real Vertex');
      details.push({id:model.id,tool:call.name,continuation:text});
      await fs.writeFile(output,JSON.stringify({running:true,checks,details},null,2));

      const early = new vscode.CancellationTokenSource();
      const timer = setTimeout(()=>early.cancel(),250);
      let rejected=false;
      const started=Date.now();
      try {
        const response=await model.sendRequest([vscode.LanguageModelChatMessage.User('Count from 1 to 1000, one number on each line.')],{},early.token);
        for await (const _part of response.stream) {}
      } catch (e) { if (!early.token.isCancellationRequested) throw e; rejected=true; }
      finally {clearTimeout(timer);early.dispose();}
      assert.ok(early.token.isCancellationRequested);
      assert.ok(Date.now()-started<10_000);
      checks.push(model.id+': cancellation before output completed promptly');
      details.push({id:model.id,cancellationBeforeOutputMs:Date.now()-started,rejected});

      const during=new vscode.CancellationTokenSource();
      let received=false;
      try {
        const response=await model.sendRequest([vscode.LanguageModelChatMessage.User('Count from 1 to 1000, one number on each line.')],{},during.token);
        for await (const part of response.stream) if(part instanceof vscode.LanguageModelTextPart && part.value) {received=true;during.cancel();}
      } catch(e) {if(!during.token.isCancellationRequested) throw e;}
      finally {during.dispose();}
      assert.ok(received,model.id+' emitted text before cancellation');
      checks.push(model.id+': cancellation after first streamed text reached the real provider');
      await fs.writeFile(output,JSON.stringify({running:true,checks,details},null,2));
    }

    const gitExtension=vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExtension);
    const git=(await gitExtension.activate()).getAPI(1);
    const resource=vscode.workspace.workspaceFolders[0].uri;
    const repo=git.getRepository(resource);
    assert.ok(repo);
    const file=path.join(resource.fsPath,'proxy-test.txt');
    await fs.writeFile(file,'Local proxy integration fixture.\n');
    await exec('git',['add','proxy-test.txt'],{cwd:resource.fsPath});
    for(let i=0;i<50 && repo.state.indexChanges.length===0;i++) await new Promise(r=>setTimeout(r,100));
    assert.ok(repo.state.indexChanges.length>0);
    const logsDir=path.join(userData,'User','globalStorage','jorsm.vertex-ai-models-chat-provider','usage_logs');
    const readUsage=async()=> (await Promise.all((await fs.readdir(logsDir)).filter(f=>f.endsWith('.jsonl')).map(async f=>(await fs.readFile(path.join(logsDir,f),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)))).flat();
    const before=(await readUsage()).length;
    await vscode.commands.executeCommand('vertexAiChat.generateCommitMessage',resource);
    assert.ok(repo.inputBox.value.trim() && !repo.inputBox.value.includes('Generating'));
    const usage=await readUsage();
    assert.equal(usage.length,before+1,'commit generation records exactly one usage entry');
    for (const family of ['gemini','claude']) {
      const model=models.find(m=>m.family===family);
      assert.ok(usage.some(row=>row.model===model.id && row.cost>0),model.id+' records server-priced usage');
    }
    checks.push('actual SCM command generated a commit message via proxy and recorded usage once');
    details.push({commitMessage:repo.inputBox.value,usageRecords:usage.length});
    await fs.writeFile(output,JSON.stringify({ok:true,checks,details},null,2));
  } catch(e) {
    await fs.writeFile(output,JSON.stringify({ok:false,checks,details,error:String(e)},null,2));
    throw e;
  }
};
