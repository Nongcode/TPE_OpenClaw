const crypto = require('crypto');
const http = require('http');

const appSecret = '4e6e7e1406fd946467bc8a89dd591154';
const payload = JSON.stringify({
  "object": "page",
  "entry": [
    {
      "id": "643048852218433",
      "time": Date.now(),
      "messaging": [
        {
          "sender": { "id": "12334" },
          "recipient": { "id": "643048852218433" },
          "timestamp": Date.now(),
          "message": {
            "mid": "mid.$TEST_MOCK_12345",
            "text": "Alo thử nghiệm máy tháo và ra vào lốp cho tôi nhé!"
          }
        }
      ]
    }
  ]
});

const sig = crypto.createHmac('sha256', appSecret).update(payload, 'utf8').digest('hex');
const req = http.request('http://127.0.0.1:3000/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-hub-signature-256': 'sha256=' + sig
  }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log('Status: ' + res.statusCode + ' Body: ' + d));
});
req.write(payload);
req.end();
