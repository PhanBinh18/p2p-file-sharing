/**
 * Test kịch bản bắt tay và hợp đồng giao thức giữa 2 client
 */

async function runTest() {
  console.log('--- Bắt đầu kiểm tra giao thức WebSocket và Signaling ---');

  const wsA = new WebSocket('ws://localhost:3000/ws');
  const wsB = new WebSocket('ws://localhost:3000/ws');

  await Promise.all([
    new Promise(r => wsA.onopen = r),
    new Promise(r => wsB.onopen = r)
  ]);
  console.log('✓ Cả 2 WebSocket client đã kết nối');

  let roomCode = '';

  // 1. Client A tạo phòng
  const pA_created = new Promise(resolve => {
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'room-created') {
        resolve(msg);
      }
    };
  });

  wsA.send(JSON.stringify({ type: 'create-room', nickname: 'Alice' }));
  const createdMsg = await pA_created;
  roomCode = createdMsg.roomCode;
  console.log(`✓ Alice đã tạo phòng: ${roomCode} (peerId: ${createdMsg.peerId})`);

  // 2. Client B xin vào phòng
  const pB_pending = new Promise(resolve => {
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'join-pending') resolve(msg);
    };
  });

  const pA_request = new Promise(resolve => {
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'join-request') resolve(msg);
    };
  });

  wsB.send(JSON.stringify({ type: 'join-room', roomCode, nickname: 'Bob' }));
  const [bPending, aRequest] = await Promise.all([pB_pending, pA_request]);
  console.log(`✓ Bob đã gửi yêu cầu (${bPending.peerId}), Alice nhận join-request từ: ${aRequest.nickname}`);

  // 3. Alice chấp nhận Bob
  const pB_accepted = new Promise(resolve => {
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'join-accepted') resolve(msg);
    };
  });

  wsA.send(JSON.stringify({ type: 'join-decision', accept: true }));
  const bAccepted = await pB_accepted;
  console.log(`✓ Bob nhận join-accepted từ host: ${bAccepted.hostNickname}`);

  // 4. Bob gửi peer-ready
  const pA_peerReady = new Promise(resolve => {
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'peer-ready') resolve(msg);
    };
  });

  wsB.send(JSON.stringify({ type: 'peer-ready' }));
  const aPeerReady = await pA_peerReady;
  console.log(`✓ Alice nhận peer-ready từ: ${aPeerReady.nickname}`);

  // 5. Alice gửi offer -> Bob nhận
  const pB_offer = new Promise(resolve => {
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'offer') resolve(msg);
    };
  });

  wsA.send(JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=alice 1234 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }));
  const bOffer = await pB_offer;
  console.log(`✓ Bob nhận offer từ Alice (SDP length: ${bOffer.sdp.length})`);

  // 6. Bob gửi answer -> Alice nhận
  const pA_answer = new Promise(resolve => {
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'answer') resolve(msg);
    };
  });

  wsB.send(JSON.stringify({ type: 'answer', sdp: 'v=0\r\no=bob 5678 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }));
  const aAnswer = await pA_answer;
  console.log(`✓ Alice nhận answer từ Bob (SDP length: ${aAnswer.sdp.length})`);

  // 7. Trao đổi ICE candidate
  const pB_ice = new Promise(resolve => {
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ice-candidate') resolve(msg);
    };
  });

  wsA.send(JSON.stringify({
    type: 'ice-candidate',
    candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  }));
  const bIce = await pB_ice;
  console.log(`✓ Bob nhận ice-candidate từ Alice`);

  wsA.close();
  wsB.close();
  console.log('🎉 Toàn bộ chu trình kiểm tra giao thức Signaling & WebRTC ĐẠT 100%!');
  process.exit(0);
}

runTest().catch(err => {
  console.error('Test thất bại:', err);
  process.exit(1);
});
