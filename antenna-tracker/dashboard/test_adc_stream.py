import struct
import time
import unittest
import zlib
from adc_stream import MAGIC, MAGIC2, SCAN, Stream
from relay import Relay, Parser


def packet(records):
    payload = struct.pack('<H', len(records)) + b''.join(SCAN.pack(*r) for r in records)
    return MAGIC + struct.pack('<H', len(payload)) + payload + struct.pack('<I', zlib.crc32(payload))


def record(sequence, stamp, value=2048, valid=0xFFFF):
    return (sequence, stamp, valid, *([value] * 16))


class StreamTests(unittest.TestCase):
    def test_compact_packets_preserve_all_counts_timestamps_and_sequence_wrap(self):
        import random
        randomizer = random.Random(17)
        records = [((0xFFFFFFC0 + i) & 0xFFFFFFFF, 987654321000 + i * 101, 0xFFFE if i == 7 else 0xFFFF,
                    *[randomizer.randrange(4096) for _ in range(16)]) for i in range(128)]
        payload = bytearray(struct.pack('<HIQ', len(records), records[0][0], records[0][1]))
        for sequence, stamp, valid, *raw in records:
            payload.extend(struct.pack('<HHH', (sequence - records[0][0]) & 0xFFFFFFFF, stamp - records[0][1], valid))
            for a, b in zip(raw[::2], raw[1::2]): payload.extend((a & 255, (a >> 8) | ((b & 15) << 4), b >> 4))
        wire = MAGIC2 + struct.pack('<H', len(payload)) + payload + struct.pack('<I', zlib.crc32(payload))
        for step in (1, 7, 64, 4096):
            actual, errors = [], []
            stream = Stream(lambda _: None, lambda r, p: actual.extend(r), lambda: errors.append(1))
            for start in range(0, len(wire), step): stream.feed(wire[start:start+step])
            self.assertEqual(actual, records)
            self.assertFalse(errors)

    def test_arbitrary_chunking_text_binary_and_embedded_newlines(self):
        for step in (1, 3, 7, 4096):
            text, batches, errors = [], [], []
            stream = Stream(text.append, lambda r, p: batches.extend(r), lambda: errors.append(1))
            records = [record(10, 1000, 10), record(11, 1100, 4095)]
            data = b'Banner\nTime ms: 1\n' + packet(records) + b'Ranges: ACCEL=8 GYRO=2000 MAG=2000 READY=1\n\n'
            for start in range(0, len(data), step): stream.feed(data[start:start+step])
            self.assertEqual(batches, records)
            self.assertEqual(text, ['Banner', 'Time ms: 1', 'Ranges: ACCEL=8 GYRO=2000 MAG=2000 READY=1', ''])
            self.assertFalse(errors)

    def test_crc_damage_bad_lengths_and_recovery(self):
        batches, errors = [], []
        stream = Stream(lambda _: None, lambda r, p: batches.extend(r), lambda: errors.append(1))
        bad = bytearray(packet([record(1, 100)])); bad[-1] ^= 1
        good = [record(2, 200)]
        stream.feed(MAGIC + b'\xff\xff' + bytes(bad) + packet(good))
        self.assertEqual(batches, good)
        self.assertGreaterEqual(len(errors), 2)
        stream.feed(b'x' * 50000)
        self.assertLessEqual(len(stream.pending), 4)

    def test_summary_preserves_spike_validity_and_sequence_gaps(self):
        relay = Relay()
        parser = Parser(relay.sample)
        for line in ['Time ms: 1', 'Ranges: ACCEL=8 GYRO=2000 MAG=2000 READY=1', '']:
            parser.line(line)
        records = [record(1, 100, 1000), record(2, 200, 4095), record(4, 400, 1100, 0xFFFE)]
        relay.adc_batch(records, packet(records))
        latest = relay.snapshot()['latest']
        self.assertIsNone(latest['adc'][0])
        self.assertEqual(latest['adc_min'][1], 1000)
        self.assertEqual(latest['adc_max'][1], 4095)
        self.assertEqual(latest['ranges']['accel'], 8)
        self.assertEqual(relay.snapshot()['acquisition']['sequence_gaps'], 1)
        relay.adc_batch([record(1, 10)], packet([record(1, 10)]))
        self.assertEqual(relay.snapshot()['acquisition']['sequence_gaps'], 1)

    def test_10khz_decode_and_summary_throughput(self):
        relay = Relay()
        stream = Stream(lambda _: None, relay.adc_batch, relay.corrupt_packet)
        started = time.perf_counter()
        for start in range(0, 10000, 64):
            records = [record(i+1, (i+1)*100) for i in range(start, min(start+64, 10000))]
            stream.feed(packet(records))
        elapsed = time.perf_counter() - started
        self.assertEqual(relay.raw_scans, 10000)
        self.assertEqual(relay.sequence_gaps, 0)
        self.assertLess(elapsed, 1.0, 'Relay cannot decode 10k scans per second')
        print(f'10k-scan decode + summaries: {elapsed:.3f}s')

    def test_ranges_validation_staleness_and_serial_payload(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), ranges=dict(ready=1)))
        relay.command_ranges(dict(accel=16, gyro=500))
        self.assertEqual(relay.commands.get_nowait(), b'RANGE 16 500\n')
        for data in [dict(accel=3, gyro=500), dict(accel=16, gyro=100), dict(accel=True, gyro=500)]:
            with self.assertRaises(ValueError): relay.command_ranges(data)
        relay.samples[-1]['received_at'] -= 10
        with self.assertRaises(ValueError): relay.command_ranges(dict(accel=8, gyro=2000))


if __name__ == '__main__': unittest.main()
