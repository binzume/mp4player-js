'use strict';
class BufferedReader {
    constructor(options = {}) {
        this.reader = options.reader || null;
        this.opener = options.opener || null;
        this.littleEndian = options.littleEndian || false;
        this.reopenThireshold = options.reopenThireshold || 1024;
        this.buffers = [];
        this.bufferEnd = 0;
        this.position = 0;
        this._currentBuffer = null;
        this._currentDataView = null;
        this._currentRemainings = 0;
        this._currentBufferOffset = 0;
        this._tmpBuffer = new ArrayBuffer(8);
        this._tmpDataView = new DataView(this._tmpBuffer);
        this._tmpBytes = new Uint8Array(this._tmpBuffer);
    }
    available() {
        return this.bufferEnd - this.position;
    }
    seek(p) {
        if (p >= this._currentBufferOffset && p < this.bufferEnd + this.reopenThireshold) {
            this._move(p - this.position);
            return;
        }
        if (!this.opener) {
            throw 'cannnot seek';
        }
        if (this.reader && this.reader.cancel) {
            this.reader.cancel();
        }
        this.position = p;
        this.bufferEnd = p;
        this._currentBuffer = null;
        this._currentBufferOffset = p;
        this._currentRemainings = 0;
        this.buffers = [];
        this.reader = null;
    }
    async bufferAsync(sz) {
        if (this.reader === null) {
            if (this.opener) {
                this.reader = await this.opener.open(this.position);
            } else {
                return this.available() >= sz;
            }
        }
        while (this.available() < sz) {
            let { done, value } = await this.reader.read();
            if (done) {
                return false;
            }
            this.appendBuffer(value);
        }
        return true;
    }
    appendBuffer(buffer) {
        this.buffers.push(buffer);
        this.bufferEnd += buffer.byteLength;
    }
    _move(n) {
        this.position += n;
        this._currentRemainings -= n;
        return this.position - this._currentBufferOffset - n;
    }
    _updateCurrentBuffer() {
        while (this._currentRemainings <= 0 && this.buffers.length > 0) {
            this._currentBufferOffset += this._currentBuffer ? this._currentBuffer.byteLength : 0;
            this._currentBuffer = this.buffers.shift();
            this._currentDataView = null;
            this._currentRemainings += this._currentBuffer.byteLength;
        }
    }
    _getDataView(n) {
        if (this.available() < n) {
            throw "no buffered data";
        }
        this._updateCurrentBuffer();
        if (this._currentRemainings >= n) {
            this._currentDataView = this._currentDataView || new DataView(this._currentBuffer.buffer);
            return [this._currentDataView, this._move(n)];
        }
        this.readBytesTo(this._tmpBytes, 0, n);
        return [this._tmpDataView, 0];
    }
    readBytesTo(bytes, offset, size) {
        let p = offset || 0;
        let end = size != null ? size - p : bytes.length;
        while (p < end) {
            this._updateCurrentBuffer();
            let l = Math.min(end - p, this._currentRemainings);
            bytes.set(this._currentBuffer.slice(this._move(l), this.position - this._currentBufferOffset), p);
            p += l;
        }
        return bytes;
    }
    readData(len) {
        let result = [];
        let p = 0;
        while (p < len) {
            this._updateCurrentBuffer();
            let l = Math.min(len - p, this._currentRemainings);
            result.push(this._currentBuffer.slice(this._move(l), this.position - this._currentBufferOffset));
            p += l;
        }
        return result;
    }
    read8() {
        let [v, p] = this._getDataView(1);
        return v.getUint8(p, this.littleEndian);
    }
    read16() {
        let [v, p] = this._getDataView(2);
        return v.getUint16(p, this.littleEndian);
    }
    read32() {
        let [v, p] = this._getDataView(4);
        return v.getUint32(p, this.littleEndian);
    }
    read64() {
        let left = this.read32();
        let right = this.read32();
        return this.littleEndian ? left + 2 ** 32 * right : 2 ** 32 * left + right;
    }
    async read32Async() {
        return (await this.bufferAsync(4)) && this.read32();
    }
}

class BufferWriter {
    constructor(size) {
        this.buffer = new ArrayBuffer(size);
        this.dataView = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
        this.littleEndian = false;
        this.position = 0;
    }
    write8(v) {
        this.bytes[this.position] = v;
        this.position += 1;
    }
    write16(v) {
        this.dataView.setUint16(this.position, v, this.littleEndian);
        this.position += 2;
    }
    write32(v) {
        this.dataView.setUint32(this.position, v, this.littleEndian);
        this.position += 4;
    }
    write64(v) {
        this.write32(v / 2 ** 32);
        this.write32(v);
    }
    writeBytes(v) {
        this.bytes.set(v, this.position);
        this.position += v.length;
    }
}

class Box {
    constructor(type, size) {
        this.type = type;
        this.size = size;
        this.isFullBox = false;
        this.HEADER_SIZE = 8;
    }
    findByType(type) {
        return this.type == type ? this : null;
    }
    findByTypeAll(type, result) {
        if (this.type == type) {
            result.push(this);
        }
        return result;
    }
    updateSize() { return this.size; }
    async parse(r) {
        throw 'not implemented';
    }
    async write(w) {
        throw 'not implemented';
    }
    writeBoxHeader(w) {
        w.write32(this.size);
        w.writeBytes([...this.type].map(s => s.charCodeAt(0)));
    }
}

class SimpleBoxList extends Box {
    constructor(type, size = 0) {
        super(type, size);
        this.children = [];
        this._nextBox = null;
        this._buf4 = new Uint8Array(4);
    }
    updateSize() {
        this.size = this.children.reduce((sum, b) => sum + b.updateSize(), 8);
        return this.size;
    }
    async peekNextBox(r) {
        if (this.nextBox) {
            return this.nextBox;
        }
        if (!await r.bufferAsync(8)) {
            return null;
        }
        let size = r.read32();
        let type = String.fromCharCode(...r.readBytesTo(this._buf4));
        this.nextBox = this.newBox(type, size);
        return this.nextBox;
    }
    async parseBox(r) {
        let b = await this.peekNextBox(r);
        if (b === null) {
            return null;
        }
        this.nextBox = null;
        if (!await r.bufferAsync(b.size - 8)) {
            throw 'failed to read box:' + b.type;
        }
        await b.parse(r);
        return b;
    }
    async parse(r) {
        let pos = this.HEADER_SIZE;
        let end = this.size;
        while (pos < end) {
            let b = await this.parseBox(r);
            if (b === null) {
                break;
            }
            this.children.push(b);
            pos += b.size;
        }
    }
    newBox(typ, sz) {
        return new GenericBox(typ, sz);
    }
    async write(w) {
        for (let b of this.children) {
            b.updateSize();
            b.writeBoxHeader(w);
            await b.write(w);
        }
    }
    findByType(type) {
        if (this.type == type) {
            return this;
        }
        for (let child of this.children) {
            let found = child.findByType(type);
            if (found) {
                return found;
            }
        }
        return null;
    }
    findByTypeAll(type, result) {
        if (this.type == type) {
            result.push(this);
        }
        this.children.forEach(c => c.findByTypeAll(type, result));
        return result;
    }
}

class FullBox extends Box {
    constructor(type, size) {
        super(type, size);
        this.version = 0;
        this.flags = 0;
        this.isFullBox = true;
        this.HEADER_SIZE = 12;
    }
    async parse(r) {
        this.version = r.read8();
        this.flags = r.read16() << 8 | r.read8();
    }
    async write(w) {
        w.write8(this.version);
        w.write16(this.flags >> 8);
        w.write8(this.flags & 0xff);
    }
}

class FullBufBox extends FullBox {
    constructor(type, size) {
        super(type, size);
        this.buf = new ArrayBuffer(size - this.HEADER_SIZE);
        this.dataView = new DataView(this.buf);
    }
    wrap(fullbox) {
        if (this.type != fullbox.type) {
            throw "invalid type:" + fullbox.type;
        }
        this.size = fullbox.size;
        this.version = fullbox.version;
        this.flags = fullbox.flags;
        this.buf = fullbox.buf;
        this.dataView = fullbox.dataView;
    }
    updateSize() {
        this.size = this.buf.byteLength + this.HEADER_SIZE;
        return this.size;
    }
    async parse(r) {
        await super.parse(r);
        r.readBytesTo(new Uint8Array(this.buf), 0, this.size - this.HEADER_SIZE);
    }
    async write(w) {
        await super.write(w);
        w.writeBytes(new Uint8Array(this.buf));
    }
    r8(pos) {
        return this.dataView.getUint8(pos);
    }
    r16(pos) {
        return this.dataView.getUint16(pos);
    }
    r32(pos) {
        return this.dataView.getUint32(pos);
    }
    r64(pos) {
        let h = this.dataView.getUint32(pos);
        let l = this.dataView.getUint32(pos + 4);
        return 2 ** 32 * h + l;
    }
    w8(pos, v) {
        this.dataView.setUint8(pos, v);
    }
}

class BoxSTSC extends FullBufBox {
    constructor(type = "stsc", size = 16) {
        super(type, size);
    }
    count() { return this.r32(0); }
    first(n) { return this.r32(4 + n * 12); }
    spc(n) { return this.r32(4 + n * 12 + 4); }
    getCursor(n) { // n: [0..(numSample-1)]
        let ofs = 0, ch = 1, lch = 1, lspc = 1;
        let c = this.count();
        let i = 0;
        for (; i < c; i++) {
            let first = this.first(i);
            ch = lch + ((n - ofs) / lspc | 0);
            if (first > ch) break;
            ofs += (first - lch) * lspc;
            lspc = this.spc(i);
            lch = first;
        }
        return [ch - 1, ofs + (ch - lch + 1) * lspc - n, i - 1, 0]; // [chunk, scount, entry, offset]
    }
    next(c) {
        if (--c[1] == 0) {
            c[0]++;
            c[3] = 0;
            if (c[2] + 1 < this.count() && c[0] + 1 >= this.first(c[2] + 1)) {
                c[2]++;
            }
            c[1] = this.spc(c[2]);
        }
    }
}

class BoxSTTS extends FullBufBox {
    constructor(type = "stts", size = 16) {
        super(type, size);
    }
    count() { return this.r32(0); }
    count1(n) { return this.r32(4 + n * 8); }
    delta(n) { return this.r32(4 + n * 8 + 4); }
    getCursor(n) { // n: [0..(numSample-1)]
        let count = this.count();
        let t = 0;
        for (let i = 0; i < count; i++) {
            let c = this.count1(i), d = this.delta(i);
            if (n < c) {
                return [t + n * d, d, c - n, i];
            }
            n -= c;
            t += c * d;
        }
        return [t, 0, 0, 0];
    }
    next(c) {
        if (--c[2] == 0 && c[3] + 1 < this.count()) {
            c[1] = this.delta(++c[3]);
            c[2] = this.count1(c[3]);
        }
        c[0] += c[1];
    }
    timeToSample(t) {
        let count = this.count();
        let p = 0;
        for (let i = 0; i < count; i++) {
            let c = this.count1(i), d = this.delta(i);
            if (t < c * d) {
                return p + (t / d) | 0;
            }
            p += c;
            t -= c * d;
        }
        return p;
    }
}

class BoxCTTS extends FullBufBox {
    constructor(type = "ctts", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    count1(n) { return this.r32(4 + n * 8); }
    offset(n) { return this.r32(4 + n * 8 + 4); }
    getCursor(n) { // n: [0..(numSample-1)]
        let c = this.count();
        let s = 0;
        for (let i = 0; i < c; i++) {
            s += this.count1(i);
            if (n < s) return [i, s - n];
        }
        return null;
    }
    next(c) {
        if (--c[1] == 0 && c[0] + 1 < this.count()) {
            c[1] = this.count1(++c[0]);
        }
    }
}

class BoxSTCO extends FullBufBox {
    constructor(type = "stco", size = 16) {
        super(type, size);
    }
    count() { return this.r32(0); }
    offset(n) { return this.type == 'co64' ? this.r64(4 + n * 8) : this.r32(4 + n * 4); }
}

class BoxSTSS extends FullBufBox {
    constructor(type = "stss", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    sync(pos) { return this.r32(4 + pos * 4); }
}

class BoxSTSZ extends FullBufBox {
    constructor(type = "stsz", size = 20) {
        super(type, size);
    }
    constantSize() { return this.r32(0); }
    count() { return this.r32(4); }
    sampleSize(pos) { return this.r32(8 + pos * 4); }
}

class BoxTREX extends FullBox {
    constructor(type = "trex", size = 32) {
        super(type, size);
        this.trackId = 1;
        this.sampleDesc = 1;
        this.sampleDuration = 0;
        this.sampleSize = 0;
        this.sampleFlags = 0;
    }
    async parse(r) {
        await super.parse(r);
        this.trackId = r.read32();
        this.sampleDesc = r.read32();
        this.sampleDuration = r.read32();
        this.sampleSize = r.read32();
        this.sampleFlags = r.read32();
    }
    async write(w) {
        await super.write(w);
        w.write32(this.trackId);
        w.write32(this.sampleDesc);
        w.write32(this.sampleDuration);
        w.write32(this.sampleSize);
        w.write32(this.sampleFlags);
    }
}

class BoxMFHD extends FullBox {
    constructor(type = "mfhd", size = 16) {
        super(type, size);
        this.sequenceNumber = 1;
    }
    async parse(r) {
        await super.parse(r);
        this.sequenceNumber = r.read32();
    }
    async write(w) {
        await super.write(w);
        w.write32(this.sequenceNumber);
    }
}

class BoxTFHD extends FullBox {
    static FLAG_BASE_DATA_OFFSET = 0x01;
    static FLAG_STSD_ID = 0x02;
    static FLAG_DEFAULT_DURATION = 0x08;
    static FLAG_DEFAULT_SIZE = 0x10;
    static FLAG_DEFAULT_FLAGS = 0x20;
    static FLAG_DURATION_IS_EMPTY = 0x010000;
    static FLAG_DEFAULT_BASE_IS_MOOF = 0x020000;

    constructor(type = "tfhd", size = 0) {
        super(type, size);
        this.trackId = 1;
        this.defaultDuration = 0;
        this.defaultSize = 0;
        this.defaultFlags = 0;
    }
    async parse(r) {
        await super.parse(r);
        this.trackId = r.read32();
        // TODO
    }
    async write(w) {
        await super.write(w);
        w.write32(this.trackId);
        if (this.flags & BoxTFHD.FLAG_BASE_DATA_OFFSET) {
            w.write64(0);
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_DURATION) {
            w.write32(this.defaultDuration);
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_SIZE) {
            w.write32(this.defaultSize);
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_FLAGS) {
            w.write32(this.defaultFlags);
        }
    }
    updateSize() {
        this.size = this.HEADER_SIZE + 4;
        if (this.flags & BoxTFHD.FLAG_BASE_DATA_OFFSET) {
            this.size += 8;
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_DURATION) {
            this.size += 4;
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_SIZE) {
            this.size += 4;
        }
        if (this.flags & BoxTFHD.FLAG_DEFAULT_FLAGS) {
            this.size += 4;
        }
        return this.size;
    }
}

class BoxTFDT extends FullBox {
    constructor(type = "tfdt", size = 0) {
        super(type, size);
        this.version = 0; // size < 4GB
        this.flagStart = 0;
    }
    async parse(r) {
        await super.parse(r);
        this.flagStart = this.version == 1 ? r.read64() : r.read32();
    }
    async write(w) {
        await super.write(w);
        this.version == 1 ? w.write64(this.flagStart) : w.write32(this.flagStart);
    }
    updateSize() {
        this.size = this.HEADER_SIZE + (this.version == 1 ? 8 : 4);
        return this.size;
    }
}

class BoxTRUN extends FullBox {
    static FLAG_DATA_OFFSET = 0x01;
    static FLAG_FIRST_SAMPLE_FLAGS = 0x04;
    static FLAG_SAMPLE_DURATION = 0x0100;
    static FLAG_SAMPLE_SIZE = 0x0200;
    static FLAG_SAMPLE_FLAGS = 0x0400;
    static FLAG_SAMPLE_CTS = 0x0800;

    constructor(type = "trun", size = 0) {
        super(type, size);
        this.dataOffset = 0;
        this.data = [];
    }

    count() { return this.data.length / this._fields() | 0; }

    add(v) {
        this.data.push(v);
    }
    async parse(r) {
        await super.parse(r);
        let count = r.read32();
        if (this.flags & BoxTRUN.FLAG_DATA_OFFSET) {
            this.dataOffset = r.read32();
        }
        if (this.flags & BoxTRUN.FLAG_FIRST_SAMPLE_FLAGS) {
            r.read32();
        }

        let len = count * this._fields();
        for (let i = 0; i < len; i++) {
            this.data.push(r.read32());
        }
    }
    async write(w) {
        await super.write(w);
        w.write32(this.data.length / this._fields());
        if (this.flags & BoxTRUN.FLAG_DATA_OFFSET) {
            w.write32(this.dataOffset);
        }
        if (this.flags & BoxTRUN.FLAG_FIRST_SAMPLE_FLAGS) {
            w.write32(0);
        }
        for (let v of this.data) {
            w.write32(v);
        }
    }
    updateSize() {
        this.size = this.HEADER_SIZE + 4 + 4 * this.data.length;
        if (this.flags & BoxTRUN.FLAG_DATA_OFFSET) {
            this.size += 4;
        }
        if (this.flags & BoxTRUN.FLAG_FIRST_SAMPLE_FLAGS) {
            this.size += 4;
        }
        return this.size;
    }

    _fields() {
        let f = 0;
        if (this.flags & BoxTRUN.FLAG_SAMPLE_DURATION) f++;
        if (this.flags & BoxTRUN.FLAG_SAMPLE_SIZE) f++;
        if (this.flags & BoxTRUN.FLAG_SAMPLE_FLAGS) f++;
        if (this.flags & BoxTRUN.FLAG_SAMPLE_CTS) f++;
        return f;
    }
}

class GenericBox extends Box {
    constructor(type, size) {
        super(type, size);
        this.data = [];
    }
    allocBuffer() {
        this.buf = new ArrayBuffer(this.size - this.HEADER_SIZE);
        this.bytes = new Uint8Array(this.buf);
        this.dataView = new DataView(this.buf);
        this.data = [this.bytes];
    }
    updateSize() {
        return this.size;
    }
    async parse(r) {
        this.allocBuffer();
        r.readBytesTo(this.bytes, 0, this.size - this.HEADER_SIZE);
    }
    async write(w) {
        let wrote = 0;
        this.data.forEach(b => { w.writeBytes(b); wrote += b.length });
        if (wrote != this.size - this.HEADER_SIZE) {
            throw "invalid data size";
        }
    }
}

const SAMPLE_FLAGS_NO_SYNC = 0x01010000;
const SAMPLE_FLAGS_SYNC = 0x02000000;
const CONTAINER_BOX = new Set(["moov", "trak", "dts\0", "mdia", "minf", "stbl", "udta", "moof", "traf", "edts", "mvex"]);
const BOXES = {
    "stco": BoxSTCO, "stsc": BoxSTSC, "stsz": BoxSTSZ, "stss": BoxSTSS, "stts": BoxSTTS, "ctts": BoxCTTS,
    "tfdt": BoxTFDT, "trex": BoxTREX, "trun": BoxTRUN, "mdhd": FullBufBox, "stsd": FullBufBox, "co64": BoxSTCO
};

class MP4Container extends SimpleBoxList {
    constructor(type = "MP4", size = 0xffffffff) {
        super(type, size);
    }
    newBox(typ, sz) {
        if (CONTAINER_BOX.has(typ)) {
            return new MP4Container(typ, sz);
        } else if (BOXES[typ]) {
            return new BOXES[typ](typ, sz);
        }
        return new GenericBox(typ, sz);
    }
}

class Mp4SampleReader {
    constructor(track) {
        this.stsc = track.findByType('stsc');
        this.stss = track.findByType('stss');
        this.stsz = track.findByType('stsz');
        this.stco = track.findByType('stco') || track.findByType('co64');
        this.stts = track.findByType('stts');
        this.ctts = track.findByType('ctts');
        let mdhd = track.findByType('mdhd');
        this.timeScale = mdhd.version ? mdhd.r32(16) : mdhd.r32(8); // TODO
        this.position = 0;
        this.timeOffsetCursor = null;
        this.timestampCursor = this.stts.getCursor(this.position);
        this.chunkCursor = this.stsc.getCursor(this.position);
        if (this.stss) {
            this.syncPoints = new Set();
            for (let i = 0; i < this.stss.count(); i++) {
                this.syncPoints.add(this.stss.sync(i));
            }
        }
    }
    isEos() { return this.position >= this.stsz.count(); }
    isSyncPoint(position) { return this.syncPoints == null || this.syncPoints.has(position + 1); }
    dataOffset() { return this.stco.offset(this.chunkCursor[0]) + this.chunkCursor[3]; }
    seekPosition(position) {
        this.chunkCursor = this.stsc.getCursor(position);
        this.timestampCursor = this.stts.getCursor(position);
        this.timeOffsetCursor = null;
        this.position = position;
        while (position > 0 && this.stsc.getCursor(position - 1)[0] == this.chunkCursor[0]) {
            position--;
            this.chunkCursor[3] += this.stsz.sampleSize(position);
        }
    }
    seek(t) {
        let p = this.stts.timeToSample(t);
        while (p < this.stsz.count() && !this.isSyncPoint(p)) {
            p++;
        }
        this.seekPosition(p);
    }
    readSampleInfo() {
        let timeOffset = null;
        if (this.ctts != null) {
            if (this.timeOffsetCursor == null) {
                this.timeOffsetCursor = this.ctts.getCursor(this.position);
            }
            timeOffset = this.ctts.offset(this.timeOffsetCursor[0]);
            this.ctts.next(this.timeOffsetCursor);
        }
        let sampleInfo = {
            timestamp: this.timestampCursor[0],
            timeOffset: timeOffset,
            syncPoint: this.isSyncPoint(this.position),
            size: this.stsz.sampleSize(this.position),
            offset: this.dataOffset(),
        };
        this.chunkCursor[3] += sampleInfo.size;
        this.stsc.next(this.chunkCursor);
        this.stts.next(this.timestampCursor);
        this.position++;
        return sampleInfo;
    }
}

class MP4FragmentBuilder {
    constructor(track, seq) {
        this.track = track;
        this.seq = seq;
        this.mdatStart = 0xffffffff;
        this.mdatEnd = 0;
        this.totalSize = 0;
        this.samples = [];
        this.lastTimestamp = 0;
    }
    addSample(sample) {
        this.samples.push(sample);
        this.lastTimestamp = sample.timestamp;
        this.totalSize += sample.size;
        this.mdatStart = Math.min(sample.offset, this.mdatStart);
        this.mdatEnd = Math.max(sample.offset + sample.size, this.mdatEnd);
    }
    duration() {
        return this.samples.length < 2 ? 0 : this.lastTimestamp - this.samples[0].timestamp;
    }
    build(dstBox, data, offset) {
        let mfhd = new BoxMFHD();
        mfhd.sequenceNumber = this.seq;
        let tfhd = new BoxTFHD();
        tfhd.flags = BoxTFHD.FLAG_DEFAULT_BASE_IS_MOOF | BoxTFHD.FLAG_DEFAULT_DURATION | BoxTFHD.FLAG_DEFAULT_SIZE |
            BoxTFHD.FLAG_DEFAULT_DURATION | BoxTFHD.FLAG_DEFAULT_SIZE | BoxTFHD.FLAG_DEFAULT_FLAGS;
        tfhd.defaultSize = 0;
        tfhd.defaultFlags = SAMPLE_FLAGS_NO_SYNC;
        tfhd.trackId = this.track;
        tfhd.defaultDuration = (this.duration() / (this.samples.length - 1)) | 0;
        let tfdt = new BoxTFDT();
        tfdt.flagStart = this.samples[0].timestamp;
        let trun = new BoxTRUN();
        trun.flags = BoxTRUN.FLAG_SAMPLE_SIZE | BoxTRUN.FLAG_SAMPLE_FLAGS
            | BoxTRUN.FLAG_SAMPLE_CTS | BoxTRUN.FLAG_DATA_OFFSET;
        let traf = new SimpleBoxList("traf", 0);
        traf.children.push(tfhd);
        traf.children.push(tfdt);
        traf.children.push(trun);
        let moof = new SimpleBoxList("moof", 0);
        moof.children.push(mfhd);
        moof.children.push(traf);
        let mdat = new GenericBox('mdat', this.totalSize + 8);
        for (let sample of this.samples) {
            trun.add(sample.size);
            trun.add(sample.syncPoint ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NO_SYNC);
            trun.add(sample.timeOffset);
            mdat.data.push(data.slice(sample.offset - offset, sample.offset - offset + sample.size));
        }
        trun.dataOffset = moof.updateSize() + 8;

        dstBox.children.push(moof);
        dstBox.children.push(mdat);
        return dstBox;
    }
}

class MP4SegmentReader {
    constructor(segmentDuration) {
        this.segmentDuration = segmentDuration;
        this.codecs = [];
        this.fragmentedInput = false;

        this._perser = new MP4Container();
        this._readers = [];
        this._mdatLast = null;
        this._segmentSeq = 0;
    }
    async readSegment(br) {
        let output = new MP4Container();
        if (this.fragmentedInput) {
            let b1 = await this._perser.parseBox(br); // moof
            let b2 = await this._perser.parseBox(br); // mdat
            b1 && output.children.push(b1);
            b2 && output.children.push(b2);
            this._segmentSeq++;
        } else if (this._readers.length == 0) {
            let b;
            while ((b = await this._perser.peekNextBox(br)) !== null) {
                if (b.type == 'mdat') {
                    if (this._readers.length > 0) {
                        break;
                    }
                    this._perser.nextBox = null;
                    br.seek(br.position + b.size - 8);
                    continue;
                } else if (b.type == 'moof') {
                    this.fragmentedInput = true;
                    break;
                }
                await this._perser.parseBox(br);
                if (b.type == 'moov') {
                    let tracks = b.findByTypeAll("trak", []);
                    this._readers = tracks.map(t => new Mp4SampleReader(t));
                    this.codecs = this._getCodecs(tracks);
                    this.mimeType = 'video/mp4; codecs="' + this.codecs.join(",") + '"';
                    this._clearMoov(b, tracks);
                }
                output.children.push(b);
            }
        } else {
            let trackId = this._segmentSeq % this._readers.length + 1;
            let reader = this._readers[trackId - 1];
            let segmentEnd = ((this._segmentSeq / this._readers.length | 0) + 1)
                * this.segmentDuration * reader.timeScale;
            let mdatStart = Math.min(...this._readers.filter(r => !r.isEos()).map(r => r.dataOffset()));
            let builder = new MP4FragmentBuilder(trackId, ++this._segmentSeq);
            while (builder.lastTimestamp < segmentEnd && !reader.isEos()) {
                builder.addSample(reader.readSampleInfo());
            }
            if (builder.duration() > 0) {
                mdatStart = Math.min(mdatStart, builder.mdatStart);
                let mdatEnd = builder.mdatEnd;
                let data;
                let mdatLastLen = this._mdatLast ? this._mdatLast.byteLength : 0;
                let dataOffset = 0;
                let mdatPos = br.position;
                if (mdatPos - mdatLastLen > mdatStart || mdatStart > mdatPos) {
                    br.seek(mdatStart);
                } else if (mdatPos > mdatStart) {
                    if (mdatEnd < mdatPos) {
                        mdatEnd = mdatPos;
                    }
                    data = new Uint8Array(mdatEnd - mdatStart); // TODO
                    dataOffset = mdatPos - mdatStart;
                    data.set(this._mdatLast.slice(mdatLastLen - dataOffset), 0);
                }
                await br.bufferAsync(mdatEnd - mdatStart - dataOffset);
                data = data || new Uint8Array(mdatEnd - mdatStart);
                br.readBytesTo(data, dataOffset);
                builder.build(output, data, mdatStart);
                this._mdatLast = data;
            }
        }
        if (output.children.length == 0) {
            return null;
        }
        let w = new BufferWriter(output.updateSize() - 8);
        await output.write(w);
        return w.buffer;
    }
    seek(t) {
        t -= t % this.segmentDuration;
        this._readers.forEach(r => r.seek(t * r.timeScale));
        this._segmentSeq = t / this.segmentDuration * this._readers.length;
    }
    _getCodecs(tracks) {
        return tracks.map(t => {
            let stsd = t.findByType("stsd");
            let configSize = stsd.r32(4);
            let c = String.fromCharCode(stsd.r8(8), stsd.r8(9), stsd.r8(10), stsd.r8(11));
            if (c == 'mp4a') {
                c += '.40.2';
            } else if (c == 'avc1') {
                // TODO: parse config
                if (configSize >= 0x67 - 8) {
                    c += '.' + (stsd.r32(0x63) >> 8).toString(16);
                }
            }
            return c;
        });
    }
    _clearMoov(moov, tracks = null) {
        tracks = tracks || moov.findByTypeAll("trak", []);
        moov.findByTypeAll("stbl", []).forEach(stbl => {
            stbl.children = [
                stbl.findByType("stsd"),
                new BoxSTTS(),
                new BoxSTSC(),
                new BoxSTSZ(),
                new BoxSTCO(),
            ];
        });
        let mvex = new SimpleBoxList("mvex", 0);
        tracks.forEach((track, i) => {
            let trex = new BoxTREX();
            trex.trackId = i + 1;
            mvex.children.push(trex);
        });
        moov.children.push(mvex);
    }
}

class MP4Player extends MP4SegmentReader {
    constructor(videoEl, options = {}) {
        super(options.segmentDuration || 5);
        this.videoEl = videoEl;
    }
    async setBufferedReader(br) {
        let initSegment = await this.readSegment(br);
        if (initSegment == null) {
            throw 'cannnot read init segment';
        }

        if (!MediaSource.isTypeSupported(this.mimeType)) {
            throw 'Unsupported MIME type or codec: ' + this.mimeType;
        }

        let mediaSource = new MediaSource();
        this.videoEl.src = URL.createObjectURL(mediaSource);
        await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));

        let sourceBuffer = mediaSource.addSourceBuffer(this.mimeType);
        sourceBuffer.addEventListener('updateend', async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // delay for debug.
            let buffer = await this.readSegment(br);
            if (buffer == null) {
                mediaSource.endOfStream();
            } else {
                sourceBuffer.appendBuffer(buffer);
            }
        });

        this.videoEl.addEventListener('seeking', async (ev) => {
            this.seek(Math.max(0, this.videoEl.currentTime - this.segmentDuration / 2));
            if (mediaSource.readyState == 'open') {
                sourceBuffer.abort();
            } else if (mediaSource.readyState == 'ended') {
                let buffer = await this.readSegment(br);
                if (buffer != null) {
                    sourceBuffer.appendBuffer(buffer);
                }
            }
        });

        sourceBuffer.appendBuffer(initSegment);
    }
}

// TODO
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BufferedReader, MP4SegmentReader, MP4Player };
}
