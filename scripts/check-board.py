"""Check direction, independent PWM, invalid commands, and the stop timeout."""
import json
import sys
import time

import serial


def main():
    with serial.Serial(sys.argv[1], 115200, timeout=1) as board:
        time.sleep(0.2)
        board.reset_input_buffer()
        number = 0

        def request(command, values=""):
            nonlocal number
            number += 1
            board.write(f"{command} {number} {values}".strip().encode() + b"\n")
            while True:
                line = board.readline()
                if not line:
                    raise RuntimeError("No board response")
                data = json.loads(line)
                if data["id"] == number:
                    return data

        def settled():
            # LEDC applies the new duty at the next PWM period boundary.
            time.sleep(0.002)
            return request("GET")

        def check(values):
            data = request("SET", f"{values[0]} {values[1]}")
            assert not data["error"], data
            assert data["motors"] == values, data
            data = settled()
            expected = []
            for value in values:
                duty = abs(value) * 1023 // 100
                expected.extend([duty, 0] if value >= 0 else [0, duty])
            assert data["duty"] == expected, data

        try:
            request("STOP")
            assert settled()["duty"] == [0, 0, 0, 0]
            for values in ([8, 0], [-8, 0], [0, 8], [0, -8], [8, -8], [-8, 8]):
                check(values)
                time.sleep(0.04)
            for _ in range(7):
                check([8, -8])
                time.sleep(0.1)
            time.sleep(0.55)
            assert request("GET")["duty"] == [0, 0, 0, 0], "Timeout did not stop PWM"
            check([8, 8])
            data = request("SET", "101 0")
            assert data["error"] and settled()["duty"] == [0, 0, 0, 0], data
            check([-8, -8])
            board.write(b"x" * 100 + b"\n")
            data = json.loads(board.readline())
            assert data["error"] and settled()["duty"] == [0, 0, 0, 0], data
            print("PASS: both PWM directions, independent outputs, command renewal, timeout, invalid input")
        finally:
            request("STOP")
            assert settled()["duty"] == [0, 0, 0, 0]


if __name__ == "__main__":
    main()
