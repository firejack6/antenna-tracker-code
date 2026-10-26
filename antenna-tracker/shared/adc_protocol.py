"""Mixed text / CRC32-framed ADC + ATS1 status transport. Standard library only."""
import struct
import zlib

MAGIC = b'\x00ATB1'
MAGIC2 = b'\x00ATB2'
MAGIC_STATUS = b'\x00ATS1'
SCAN = struct.Struct('<IQH16H')  # sequence, 64-bit device microseconds, valid, raw
MAX_PAYLOAD = 14 + 128 * 30
MAX_STATUS_PAYLOAD = 4096

def decode(payload, version):
    count = struct.unpack_from('<H', payload)[0]
    if version == 1:
        if not 1 <= count <= 64 or len(payload) != 2 + count * SCAN.size: raise ValueError('Invalid v1 size')
        return list(SCAN.iter_unpack(payload[2:]))
    if not 1 <= count <= 128 or len(payload) != 14 + count * 30: raise ValueError('Invalid v2 size')
    base_sequence, base_us = struct.unpack_from('<IQ', payload, 2)
    records = []
    for n in range(count):
        offset = 14 + n * 30
        sequence_delta, us_delta, valid = struct.unpack_from('<HHH', payload, offset)
        raw = []
        for pair in range(8):
            a, b, c = payload[offset + 6 + pair * 3: offset + 9 + pair * 3]
            raw.extend((a | ((b & 15) << 8), (b >> 4) | (c << 4)))
        records.append(((base_sequence + sequence_delta) & 0xFFFFFFFF, base_us + us_delta, valid, *raw))
    return records


class Stream:
    def __init__(self, line, batch, corrupt, status=None):
        self.line, self.batch, self.corrupt, self.status = line, batch, corrupt, status
        self.pending = bytearray()

    def feed(self, chunk):
        self.pending.extend(chunk)
        while self.pending:
            if self.pending.startswith((MAGIC, MAGIC2, MAGIC_STATUS)):
                if len(self.pending) < 7:
                    return
                size = struct.unpack_from('<H', self.pending, 5)[0]
                is_status = self.pending.startswith(MAGIC_STATUS)
                max_size = MAX_STATUS_PAYLOAD if is_status else MAX_PAYLOAD
                if not 2 <= size <= max_size:
                    del self.pending[0]
                    self.corrupt()
                    continue
                total = size + 11
                if len(self.pending) < total:
                    return
                payload = bytes(self.pending[7:7 + size])
                checksum = struct.unpack_from('<I', self.pending, 7 + size)[0]
                try:
                    if zlib.crc32(payload) != checksum: raise ValueError('CRC mismatch')
                    if is_status:
                        if self.status:
                            self.status(payload)
                    else:
                        records = decode(payload, 1 if self.pending[4] == 49 else 2)
                except (ValueError, struct.error):
                    del self.pending[0]
                    self.corrupt()
                    continue
                packet = bytes(self.pending[:total])
                del self.pending[:total]
                if not is_status:
                    self.batch(records, packet)
                continue
            markers = [position for magic in (MAGIC, MAGIC2, MAGIC_STATUS) if (position := self.pending.find(magic)) >= 0]
            marker = min(markers, default=-1)
            newline = self.pending.find(b'\n')
            if newline >= 0 and (marker < 0 or newline < marker):
                line = bytes(self.pending[:newline])
                del self.pending[:newline + 1]
                self.line(line.decode('utf8', errors='replace').rstrip('\r')[:16384])
            elif marker > 0:
                # Recover from a truncated text line or failed/partial binary write.
                del self.pending[:marker]
            elif len(self.pending) > 32768:
                del self.pending[:-4]
                self.corrupt()
            else:
                return
