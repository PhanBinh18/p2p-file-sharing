import crypto from 'node:crypto';

async function testRelay() {
  const wsA = new WebSocket('ws://127.0.0.1:3000/ws');
  const wsB = new WebSocket('ws://127.0.0.1:3000/ws');
  await Promise.all([new Promise(r => wsA.onopen = r), new Promise(r => wsB.onopen = r)]);

  let roomCode, hostPeerId, guestPeerId;
  wsA.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'room-created') {
      roomCode = msg.roomCode;
      hostPeerId = msg.peerId;
      wsB.send(JSON.stringify({ type: 'join-room', roomCode, nickname: 'Bob' }));
    }
    if (msg.type === 'join-request') {
      wsA.send(JSON.stringify({ type: 'join-decision', accept: true }));
    }
  };
  wsB.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'join-pending') {
      guestPeerId = msg.peerId;
    }
  };

  wsA.send(JSON.stringify({ type: 'create-room', nickname: 'Alice' }));
  await new Promise(r => setTimeout(r, 200));

  console.log(`✓ Phòng: ${roomCode}, Host: ${hostPeerId}, Guest: ${guestPeerId}`);

  // Upload test
  const content = Buffer.from('Hello P2P and Server Relay test file content!');
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const upRes = await fetch(`http://127.0.0.1:3000/api/relay/${roomCode}/upload`, {
    method: 'POST',
    headers: {
      'X-Peer-Id': hostPeerId,
      'X-File-Name': encodeURIComponent('test.txt'),
      'X-File-Sha256': sha,
      'Content-Length': content.length.toString(),
      'Content-Type': 'application/octet-stream'
    },
    body: content
  });

  const upJson = await upRes.json();
  console.log('✓ Upload status:', upRes.status, upJson);

  // Download test
  const downRes = await fetch(`http://127.0.0.1:3000/api/relay/${roomCode}/${upJson.fileId}?peerId=${guestPeerId}`);
  const downBuf = Buffer.from(await downRes.arrayBuffer());
  const match = downBuf.equals(content);
  console.log('✓ Download status:', downRes.status, 'Khớp nội dung:', match);

  // Stats test
  const statsRes = await fetch(`http://127.0.0.1:3000/api/stats/${roomCode}`);
  const statsJson = await statsRes.json();
  console.log('✓ Server stats:', statsJson);

  wsA.close();
  wsB.close();

  if (upRes.status === 201 && downRes.status === 200 && match) {
    console.log('🎉 Relay HTTP API test thành công 100%!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

testRelay().catch(err => {
  console.error(err);
  process.exit(1);
});
