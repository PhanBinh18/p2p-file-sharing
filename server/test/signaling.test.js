import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { RoomManager } from '../src/rooms.js';
import { RelayManager } from '../src/relay.js';
import { SignalingServer } from '../src/signaling.js';

test('Signaling WebSocket Integration Tests', async (t) => {
  let server;
  let port;
  let roomManager;
  let relayManager;
  let signalingServer;

  // Khởi động server test trên port ngẫu nhiên
  await new Promise((resolve) => {
    const app = express();
    roomManager = new RoomManager();
    relayManager = new RelayManager({
      roomManager,
      relayDir: './tmp/test-relay',
      maxFileSize: 104857600
    });
    signalingServer = new SignalingServer({ roomManager, relayManager });

    server = http.createServer(app);
    server.on('upgrade', (req, socket, head) => {
      signalingServer.handleUpgrade(req, socket, head);
    });

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  const getWsUrl = () => `ws://127.0.0.1:${port}/ws`;

  // Hàm tiện ích tạo WS client và nhận JSON
  function createClient() {
    const ws = new WebSocket(getWsUrl());
    const queue = [];
    const waiters = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter(msg);
      } else {
        queue.push(msg);
      }
    });

    return {
      ws,
      waitForOpen() {
        return new Promise((resolve) => {
          if (ws.readyState === WebSocket.OPEN) return resolve();
          ws.on('open', resolve);
        });
      },
      nextMessage() {
        return new Promise((resolve) => {
          if (queue.length > 0) {
            return resolve(queue.shift());
          }
          waiters.push(resolve);
        });
      },
      send(obj) {
        ws.send(JSON.stringify(obj));
      },
      close() {
        ws.close();
      }
    };
  }

  await t.test('Hoàn thành toàn bộ trình tự chuẩn 1–6 và trao đổi WebRTC', async () => {
    const clientA = createClient();
    const clientB = createClient();

    await Promise.all([clientA.waitForOpen(), clientB.waitForOpen()]);

    // 1. A create-room
    clientA.send({ type: 'create-room', nickname: 'Alice' });
    const msgA1 = await clientA.nextMessage();
    assert.equal(msgA1.type, 'room-created');
    assert.equal(typeof msgA1.roomCode, 'string');
    assert.equal(typeof msgA1.peerId, 'string');
    const roomCode = msgA1.roomCode;

    // 2. B join-room
    clientB.send({ type: 'join-room', roomCode, nickname: 'Bob' });
    const [msgB1, msgA2] = await Promise.all([
      clientB.nextMessage(),
      clientA.nextMessage()
    ]);

    assert.equal(msgB1.type, 'join-pending');
    assert.equal(msgA2.type, 'join-request');
    assert.equal(msgA2.nickname, 'Bob');

    // 3. A chấp nhận B
    clientA.send({ type: 'join-decision', accept: true });
    const msgB2 = await clientB.nextMessage();
    assert.equal(msgB2.type, 'join-accepted');
    assert.equal(msgB2.hostNickname, 'Alice');

    // 4. B gửi peer-ready -> A nhận peer-ready
    clientB.send({ type: 'peer-ready' });
    const msgA3 = await clientA.nextMessage();
    assert.equal(msgA3.type, 'peer-ready');
    assert.equal(msgA3.nickname, 'Bob');

    // 5. A gửi offer -> B nhận offer kèm from
    clientA.send({ type: 'offer', sdp: 'fake-offer-sdp' });
    const msgB3 = await clientB.nextMessage();
    assert.equal(msgB3.type, 'offer');
    assert.equal(msgB3.sdp, 'fake-offer-sdp');
    assert.equal(msgB3.from, msgA1.peerId);

    // 6. B gửi answer -> A nhận answer kèm from
    clientB.send({ type: 'answer', sdp: 'fake-answer-sdp' });
    const msgA4 = await clientA.nextMessage();
    assert.equal(msgA4.type, 'answer');
    assert.equal(msgA4.sdp, 'fake-answer-sdp');
    assert.equal(msgA4.from, msgB1.peerId);

    // 7. Trao đổi ICE candidate
    clientA.send({ type: 'ice-candidate', candidate: { candidate: 'candA' } });
    const msgB4 = await clientB.nextMessage();
    assert.equal(msgB4.type, 'ice-candidate');
    assert.equal(msgB4.candidate.candidate, 'candA');
    assert.equal(msgB4.from, msgA1.peerId);

    // 8. Khách thứ 3 thử vào khi phòng đã full -> nhận ROOM_FULL
    const clientC = createClient();
    await clientC.waitForOpen();
    clientC.send({ type: 'join-room', roomCode, nickname: 'Charlie' });
    const msgC1 = await clientC.nextMessage();
    assert.equal(msgC1.type, 'error');
    assert.equal(msgC1.code, 'ROOM_FULL');
    clientC.close();

    // 9. B đóng kết nối -> A nhận peer-left
    clientB.close();
    const msgA5 = await clientA.nextMessage();
    assert.equal(msgA5.type, 'peer-left');
    assert.equal(msgA5.peerId, msgB1.peerId);

    clientA.close();
  });

  await t.test('Từ chối khách xin vào phòng (host-declined)', async () => {
    const clientA = createClient();
    const clientB = createClient();

    await Promise.all([clientA.waitForOpen(), clientB.waitForOpen()]);

    clientA.send({ type: 'create-room', nickname: 'Alice' });
    const msgA1 = await clientA.nextMessage();

    clientB.send({ type: 'join-room', roomCode: msgA1.roomCode, nickname: 'Dave' });
    await clientB.nextMessage(); // join-pending
    await clientA.nextMessage(); // join-request

    // Host từ chối
    clientA.send({ type: 'join-decision', accept: false });
    const msgB = await clientB.nextMessage();
    assert.equal(msgB.type, 'join-rejected');
    assert.equal(msgB.reason, 'host-declined');

    clientA.close();
    clientB.close();
  });

  t.after(() => {
    signalingServer.close();
    relayManager.close();
    server.close();
  });
});
