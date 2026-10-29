"""Exercise the real BLE connection, including an optional firmware update."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path

from bleak import BleakClient, BleakScanner

command_id = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
reply_id = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
update_id = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"


async def main():
    device = await BleakScanner.find_device_by_name("Vibration", timeout=15)
    assert device, "Vibration not found"
    replies = asyncio.Queue()
    buffer = bytearray()
    number = 0

    def receive(_, data):
        buffer.extend(data)
        while b"\n" in buffer:
            line, _, rest = buffer.partition(b"\n")
            buffer[:] = rest
            replies.put_nowait(json.loads(line))

    async def request(client, command, args=""):
        nonlocal number
        number += 1
        await client.write_gatt_char(command_id, f"{command} {number} {args}".strip().encode(), response=True)
        while True:
            data = await asyncio.wait_for(replies.get(), 12)
            if data["id"] == number:
                return data

    async with BleakClient(device) as client:
        print(f"BLE MTU: {client.mtu_size}", flush=True)
        await client.start_notify(reply_id, receive)
        initial = await request(client, "STOP")
        try:
            for a, b in [(8, 0), (-8, 0), (0, 8), (0, -8), (8, -8), (-8, 8)]:
                result = await request(client, "SET", f"{a} {b}")
                assert not result["error"] and result["motors"] == [a, b], result
                await asyncio.sleep(0.003)
                result = await request(client, "GET")
                expected = []
                for value in [a, b]:
                    duty = abs(value) * 1023 // 100
                    expected.extend([duty, 0] if value >= 0 else [0, duty])
                assert result["duty"] == expected, result
            await asyncio.sleep(0.6)
            assert (await request(client, "GET"))["motors"] == [0, 0]
            image = (Path(__file__).resolve().parents[1] / "docs/firmware/app.bin").read_bytes()
            md5 = hashlib.md5(image).hexdigest()
            assert not (await request(client, "BEGIN", f"{len(image)} {md5}"))["error"]
            assert (await request(client, "SET", "8 8"))["error"], "Motors must be locked during update"
            await client.write_gatt_char(update_id, image[:128], response=True)
            assert (await request(client, "FINISH"))["error"], "Incomplete update must fail"
            assert not (await request(client, "SET", "0 0"))["error"]
            print("PASS: real BLE directions, independent PWM, timeout, update lockout, incomplete-image rejection", flush=True)
            if "--update" not in sys.argv:
                return
            assert not (await request(client, "BEGIN", f"{len(image)} {md5}"))["error"]
            last_progress = -1
            for offset in range(0, len(image), 512):
                await client.write_gatt_char(update_id, image[offset:offset + 512], response=True)
                progress = offset * 10 // len(image)
                if progress != last_progress:
                    print(f"BLE update: {progress * 10}%", flush=True)
                    last_progress = progress
            result = await request(client, "FINISH")
            assert not result["error"], result
        finally:
            if client.is_connected:
                await request(client, "STOP")
    await asyncio.sleep(3)
    buffer.clear()
    async with BleakClient(device) as client:
        await client.start_notify(reply_id, receive)
        result = await request(client, "GET")
        assert result["slot"] != initial["slot"], "Updated firmware did not boot from the other OTA slot"
        assert result["motors"] == [0, 0] and not result["error"], result
        print("PASS: BLE firmware update verified, rebooted into other OTA slot, motors stopped")


if __name__ == "__main__":
    asyncio.run(main())
