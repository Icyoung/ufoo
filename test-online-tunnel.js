const WebSocket = require('ws');

const url = 'wss://laboratories-tract-listening-merchants.trycloudflare.com/ufoo/online';
console.log('Connecting to:', url);

const ws = new WebSocket(url);

ws.on('open', () => {
    console.log('Connected! Sending hello...');
    ws.send(JSON.stringify({
        type: 'hello',
        nickname: 'test-client',
        token: 'test-token'
    }));
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

ws.on('error', (error) => {
    console.error('Error:', error.message);
});

ws.on('close', (code, reason) => {
    console.log('Connection closed:', code, reason.toString());
});

setTimeout(() => {
    console.log('Test completed.');
    ws.close();
    process.exit(0);
}, 5000);