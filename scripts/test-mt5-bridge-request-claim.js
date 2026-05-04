const fs = require('fs');
const path = require('path');

const eaPath = path.join(__dirname, '..', 'bridge', 'mql5', 'TradingBotBridgeEA.mq5');
const source = fs.readFileSync(eaPath, 'utf8');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const functionMatch = source.match(/void\s+ProcessRequestFile\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\n\/\/\+[-]+/);

if (!functionMatch) {
  fail('Could not locate ProcessRequestFile in TradingBotBridgeEA.mq5');
}

const body = functionMatch[1];
const moveIndex = body.indexOf('FileMove(request_path,FILE_COMMON,processing_path,FILE_COMMON)');
const readIndex = body.indexOf('ReadKeyValueFile(processing_path,keys,values)');
const orderIndex = body.indexOf('HandleOrder(request_id,keys,values,lines)');

if (moveIndex < 0) {
  fail('ProcessRequestFile must atomically move each request into processing before reading it');
}

if (readIndex < 0) {
  fail('ProcessRequestFile must read the claimed processing file, not the shared request file');
}

if (orderIndex < 0) {
  fail('ProcessRequestFile no longer dispatches order requests');
}

if (!(moveIndex < readIndex && readIndex < orderIndex)) {
  fail('Request claim must happen before reading/dispatching an order');
}

if (!source.includes('FolderCreate(BridgeRoot+"\\\\processing",FILE_COMMON);')) {
  fail('EnsureFolders must create the processing directory');
}

console.log('ok');
