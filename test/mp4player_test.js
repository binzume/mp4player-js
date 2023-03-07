const assert = require('assert');
const fs = require('fs');
const { BufferedReader, MP4SegmentReader } = require('../mp4player.js');


async function getReader(path, sz = 4096) {
    let f = await fs.promises.open(path, 'r');
    return ({
        async read() {
            let bytes = new Uint8Array(sz);
            let r = await f.read(bytes, 0, sz);
            if (r.bytesRead != sz) {
                bytes = new Uint8Array(bytes.slice(0, r.bytesRead));
            }
            return { done: r.bytesRead == 0, value: bytes };
        },
        async cancel() {
            await f.close();
        }
    });
}

describe('BufferedReader', () => {
    it('can read', () => {
        let br = new BufferedReader({ littleEndian: false });
        br.appendBuffer(new Uint8Array([0, 1, 2, 3]));
        br.appendBuffer(new Uint8Array([4, 5, 6, 7]));
        assert.equal(br.read8(), 0);
        assert.equal(br.read8(), 1);
        assert.equal(br.read8(), 2);
        assert.equal(br.read16(), 3 * 256 + 4);
        assert.equal(br.position, 5);
        br.seek(7);
        assert.equal(br.read8(), 7);
        br.seek(4);
        assert.equal(br.read8(), 4);
        assert.throws(() => br.seek(0), /cannnot seek/);
    });

    it('can read zero bytes', () => {
        let br = new BufferedReader({ littleEndian: false });
        br.readBytesTo(new Uint8Array([0, 1, 2, 3]), 0, 0);
        assert.equal(br.position, 0);
        br.readData(0);
        assert.equal(br.position, 0);
    });

    it('can read from file', async () => {
        let path = 'demo/videos/bunny.mp4';
        let r = await getReader(path);
        let br = new BufferedReader({ littleEndian: false, reader: r });
        await br.read32Async();
        assert.equal(await br.read32Async(), 0x66747970); // ftyp

        // already read 8 bytes
        assert.ok(await br.bufferAsync(fs.statSync(path).size - 8));
        assert.ok(!await br.bufferAsync(fs.statSync(path).size - 7));
        await r.cancel();
    });
});


describe('MP4SegmentReader', () => {
    it('can read segments', async function () {
        let path = 'demo/videos/bunny.mp4';
        let r = await getReader(path);
        let br = new BufferedReader({ littleEndian: false, reader: r });
        let player = new MP4SegmentReader(5);
        this.timeout(15000);

        assert.ok(await br.bufferAsync(fs.statSync(path).size));

        let start = process.hrtime();
        let initSegment = await player.readSegment(br);
        assert.ok(initSegment.byteLength > 0);
        // read all segments
        while (true) {
            let segment = await player.readSegment(br);
            if (segment == null) {
                break;
            }
            assert.ok(initSegment.byteLength > 0);
        }
        let t = process.hrtime(start);
        console.log(t[0] + t[1] / 1000000000);
        await r.cancel();
    });
});
