import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms.js';

test('RoomManager Unit Tests', async (t) => {
  await t.test('1. Tạo phòng thành công (open)', () => {
    const rm = new RoomManager();
    const res = rm.createRoom('Alice');

    assert.equal(typeof res.roomCode, 'string');
    assert.equal(res.roomCode.length, 6);
    assert.equal(typeof res.peerId, 'string');
    assert.equal(rm.getState(res.room), 'open');
    assert.equal(res.room.host.nickname, 'Alice');
    assert.equal(res.room.guest, null);
    assert.equal(res.room.pending, null);
  });

  await t.test('2. Khách xin vào phòng chuyển trạng thái sang pending', () => {
    const rm = new RoomManager();
    const { roomCode } = rm.createRoom('Alice');

    const joinRes = rm.joinRoom(roomCode, 'Bob');
    assert.equal(rm.getState(joinRes.room), 'pending');
    assert.equal(joinRes.room.pending.nickname, 'Bob');
    assert.equal(typeof joinRes.peerId, 'string');
  });

  await t.test('3. Khách thứ 2 vào khi đang pending bị chặn (ROOM_FULL)', () => {
    const rm = new RoomManager();
    const { roomCode } = rm.createRoom('Alice');
    rm.joinRoom(roomCode, 'Bob');

    assert.throws(() => {
      rm.joinRoom(roomCode, 'Charlie');
    }, (err) => {
      return err.code === 'ROOM_FULL';
    });
  });

  await t.test('4. Chủ phòng từ chối -> phòng trở lại open', () => {
    const rm = new RoomManager();
    const { roomCode, peerId: hostId } = rm.createRoom('Alice');
    rm.joinRoom(roomCode, 'Bob');

    const decRes = rm.decideJoin(roomCode, hostId, false);
    assert.equal(decRes.accepted, false);
    assert.equal(decRes.reason, 'host-declined');
    assert.equal(rm.getState(decRes.room), 'open');
  });

  await t.test('5. Chủ phòng đồng ý -> phòng chuyển sang full', () => {
    const rm = new RoomManager();
    const { roomCode, peerId: hostId } = rm.createRoom('Alice');
    rm.joinRoom(roomCode, 'Bob');

    const decRes = rm.decideJoin(roomCode, hostId, true);
    assert.equal(decRes.accepted, true);
    assert.equal(rm.getState(decRes.room), 'full');
    assert.equal(decRes.room.guest.nickname, 'Bob');
  });

  await t.test('6. Khách khác vào khi phòng đã full bị chặn (ROOM_FULL)', () => {
    const rm = new RoomManager();
    const { roomCode, peerId: hostId } = rm.createRoom('Alice');
    rm.joinRoom(roomCode, 'Bob');
    rm.decideJoin(roomCode, hostId, true);

    assert.throws(() => {
      rm.joinRoom(roomCode, 'Eve');
    }, (err) => {
      return err.code === 'ROOM_FULL';
    });
  });

  await t.test('7. Hết hạn timeout -> phòng quay về open', async () => {
    let timeoutFired = false;
    const rm = new RoomManager({ joinTimeoutMs: 50 });
    const { roomCode } = rm.createRoom('Alice');

    rm.joinRoom(roomCode, 'Bob', null, (code, pending) => {
      timeoutFired = true;
      assert.equal(code, roomCode);
      assert.equal(pending.nickname, 'Bob');
    });

    await new Promise(r => setTimeout(r, 80));
    assert.equal(timeoutFired, true);
    const room = rm.get(roomCode);
    assert.equal(rm.getState(room), 'open');
  });

  await t.test('8. Khách (guest) rời phòng -> phòng quay về open', () => {
    const rm = new RoomManager();
    const { roomCode, peerId: hostId } = rm.createRoom('Alice');
    const { peerId: guestId } = rm.joinRoom(roomCode, 'Bob');
    rm.decideJoin(roomCode, hostId, true);

    const leaveRes = rm.leaveRoom(roomCode, guestId);
    assert.equal(leaveRes.role, 'guest');
    assert.equal(rm.getState(rm.get(roomCode)), 'open');
  });

  await t.test('9. Chủ phòng (host) rời phòng -> phòng bị xóa hoàn toàn', () => {
    let roomClosedCode = null;
    const rm = new RoomManager({
      onRoomClosed: (code) => {
        roomClosedCode = code;
      }
    });

    const { roomCode, peerId: hostId } = rm.createRoom('Alice');
    const leaveRes = rm.leaveRoom(roomCode, hostId);

    assert.equal(leaveRes.role, 'host');
    assert.equal(rm.get(roomCode), null);
    assert.equal(roomClosedCode, roomCode);
  });

  await t.test('10. Vượt quá MAX_ROOMS -> báo lỗi RATE_LIMITED', () => {
    const rm = new RoomManager({ maxRooms: 2 });
    rm.createRoom('Alice');
    rm.createRoom('Bob');

    assert.throws(() => {
      rm.createRoom('Charlie');
    }, (err) => {
      return err.code === 'RATE_LIMITED';
    });
  });
});
