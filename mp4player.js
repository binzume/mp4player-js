"use strict";
class BufferedReader {
    constructor(options = {}) {
        this.littleEndian = false;
        this.buffers = [];
        this.bufferdSize = 0;
        this.position = 0;

        this.currentBuffer = null;
        this.currentDataView = null;
        this.currentBufferPos = 0;

        this.tmpBuffer = new ArrayBuffer(8);
        this.tmpDataView = new DataView(this.tmpBuffer);
        this.tmpBytes = new Uint8Array(this.tmpBuffer);
        this.reader = options.reader || null;
        this.opener = options.opener || null;
    }
    available() {
        return this.bufferdSize - this.currentBufferPos;
    }
    seek(p) {
        if (!this.opener) {
            throw 'cannnot seek';
        }
        if (this.reader && this.reader.cancel) {
            this.reader.cancel();
        }
        this.position = p;
        this.buffers = [];
        this.currentBuffer = null;
        this.bufferdSize = 0;
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
            this.appendBuffer(value.buffer);
        }
        return true;
    }
    appendBuffer(buffer) {
        if (this.currentBuffer === null) {
            this.currentBuffer = buffer;
            this.currentDataView = new DataView(this.currentBuffer);
            this.currentBufferPos = 0;
        } else {
            this.buffers.push(buffer);
        }
        this.bufferdSize += buffer.byteLength;
    }
    bufferNext() {
        this.bufferdSize -= this.currentBuffer.byteLength;
        this.currentBuffer = this.buffers.shift();
        this.currentDataView = new DataView(this.currentBuffer);
        this.currentBufferPos = 0;
    }
    checkBuffer(n) {
        if (this.available() < n) {
            throw "no buffered data";
        }
        let pos = this.currentBufferPos;
        if (this.currentBuffer.byteLength == pos) {
            this.bufferNext();
            pos = 0;
        }
        return this.currentBuffer.byteLength - pos >= n;
    }
    getTmpBuffer(n) {
        this.readBytesTo(this.tmpBytes, 0, n);
        return this.tmpDataView;
    }
    readBytesTo(bytes, offset, size) {
        offset = offset || 0;
        size = size || bytes.length;
        let p = 0;
        while (p < size) {
            if (this.currentBuffer.byteLength == this.currentBufferPos) {
                this.bufferNext();
            }
            let l = Math.min(size - p, this.currentBuffer.byteLength - this.currentBufferPos);
            bytes.set(new Uint8Array(this.currentBuffer, this.currentBufferPos, l), offset + p);
            p += l;
            this.currentBufferPos += l;
        }
        return bytes;
    }
    readData(len) {
        let result = [];
        let p = 0;
        while (p < len) {
            if (this.currentBuffer.byteLength == this.currentBufferPos) {
                this.bufferNext();
            }
            let l = Math.min(len - p, this.currentBuffer.byteLength - this.currentBufferPos);
            result.push(new Uint8Array(this.currentBuffer, this.currentBufferPos, l));
            p += l;
            this.currentBufferPos += l;
        }
        return result;
    }
    read8() {
        const len = 1;
        if (this.checkBuffer(len)) {
            this.currentBufferPos += len;
            return this.currentDataView.getUint8(this.currentBufferPos - len, this.littleEndian);
        }
        return this.getTmpBuffer(len).getUint8(0, this.littleEndian);
    }
    read16() {
        const len = 2;
        if (this.checkBuffer(len)) {
            this.currentBufferPos += len;
            return this.currentDataView.getUint16(this.currentBufferPos - len, this.littleEndian);
        }
        return this.getTmpBuffer(len).getUint16(0, this.littleEndian);
    }
    read32() {
        const len = 4;
        if (this.checkBuffer(len)) {
            this.currentBufferPos += len;
            return this.currentDataView.getUint32(this.currentBufferPos - len, this.littleEndian);
        }
        return this.getTmpBuffer(len).getUint32(0, this.littleEndian);
    }
    read64() {
        let left = this.read32();
        let right = this.read32();
        return this.littleEndian ? left + 2 ** 32 * right : 2 ** 32 * left + right;
    }
    async read16Async() {
        retrun(await this.bufferAsync(2)) && this.read16();
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
        this.children = [];
        this.isFullBox = false;
        this.HEADER_SIZE = 8;
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
        this._nextBox = null;
        this._buf4 = new Uint8Array(4);
    }
    updateSize() {
        this.size = 8;
        this.children.forEach(b => this.size += b.updateSize());
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
        return new UnknownBox(typ, sz);
    }
    async write(w) {
        for (let b of this.children) {
            b.updateSize();
            b.writeBoxHeader(w);
            await b.write(w);
        }
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
        let l = this.dataView.getUint32(pos);
        return 2 ** 32 * h + l;
    }
    w8(pos, v) {
        this.dataView.setUint8(pos, v);
    }
}

class BoxSTSC extends FullBufBox {
    constructor(type = "stsc", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    first(n) { return this.r32(4 + n * 12); }
    spc(n) { return this.r32(4 + n * 12 + 4); }
    sampleToChunk(n) { // n: [0..(numSample-1)]
        let ofs = 0;
        let ch = 1;
        let lch = 1;
        let lspc = 1;
        let c = this.count();
        for (let i = 0; i < c; i++) {
            let first = this.first(i), spc = this.spc(i);
            ofs += (first - lch) * lspc;
            if (n < ofs) break;
            ch = first + ((n - ofs) / spc | 0);
            lspc = spc;
            lch = first;
        }
        return ch - 1;
    }
}

class BoxSTTS extends FullBufBox {
    constructor(type = "stts", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    count1(n) { return this.r32(4 + n * 8); }
    delta(n) { return this.r32(4 + n * 8 + 4); }
    sampleToTime(n) { // n: [0..(numSample-1)]
        let c = this.count();
        let t = 0;
        for (let i = 0; i < c; i++) {
            let count = this.count1(i), d = this.delta(i);
            if (n < count) {
                return t + n * d;
            }
            n -= count;
            t += count * d;
        }
        return t;
    }
}

class BoxCTTS extends FullBufBox {
    constructor(type = "ctts", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    count1(n) { return this.r32(4 + n * 8); }
    offset(n) { return this.r32(4 + n * 8 + 4); }
    sampleToOffset(n) { // n: [0..(numSample-1)]
        let c = this.count();
        let ofs = 0;
        let s = 0;
        for (let i = 0; i < c; i++) {
            ofs = this.offset(i);
            s += this.count1(i);
            if (n < s) break;
        }
        return ofs;
    }
}

class BoxSTCO extends FullBufBox {
    constructor(type = "stco", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    offset(n) { return this.r32(4 + n * 4); }
}

class BoxSTSS extends FullBufBox {
    constructor(type = "stss", size = 0) {
        super(type, size);
    }
    count() { return this.r32(0); }
    sync(pos) { return this.r32(4 + pos * 4); }
    include(sample) {
        let c = this.count();
        for (let i = 0; i < c; i++) {
            if (this.sync(i) == sample) return true; // TODO binary search.
        }
        return false;
    }
}

class BoxSTSZ extends FullBufBox {
    constructor(type = "stsz", size = 0) {
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
        this.flags = BoxTFHD.FLAG_DEFAULT_BASE_IS_MOOF | BoxTFHD.FLAG_DEFAULT_DURATION | BoxTFHD.FLAG_DEFAULT_SIZE | BoxTFHD.FLAG_DEFAULT_DURATION;
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
        this.version = 1;
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
        this.version = 1; // always 64bit
        this.size = this.HEADER_SIZE + 8;
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

class UnknownBox extends Box {
    constructor(type, size) {
        super(type, size);
        this.buf = new ArrayBuffer(size - this.HEADER_SIZE);
        this.bytes = new Uint8Array(this.buf);
        this.dataView = new DataView(this.buf);
    }
    updateSize() {
        this.size = this.buf.byteLength + this.HEADER_SIZE;
        return this.size;
    }
    async parse(r) {
        r.readBytesTo(new Uint8Array(this.buf), 0, this.size - this.HEADER_SIZE);
    }
    async write(w) {
        w.writeBytes(new Uint8Array(this.buf));
    }
}

class UnknownBoxRef extends Box {
    constructor(type, size) {
        super(type, size);
    }
    async parse(r) {
        this.offset = r.position;
        r.readData(this.size - this.HEADER_SIZE); // TODO seek
    }
    async write(w) {
        throw "unspported type:" + this.type;
    }
}

const SAMPLE_FLAGS_NO_SYNC = 0x01010000;
const SAMPLE_FLAGS_SYNC = 0x02000000;
const CONTAINER_BOX = new Set(["moov", "trak", "dts\0", "mdia", "minf", "stbl", "udta", "moof", "traf", "edts", "mvex"]);
const SIMPLE_BOX = new Set(["ftyp", "free", "styp", 'mdat']);
const BOXES = {
    "stco": BoxSTCO,
    "stsc": BoxSTSC,
    "stsz": BoxSTSZ,
    "stss": BoxSTSS,
    "stts": BoxSTTS,
    "ctts": BoxCTTS,
    "ftdt": BoxTFDT,
    "trex": BoxTREX,
    "trun": BoxTRUN,
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
        } else if (SIMPLE_BOX.has(typ)) {
            return new UnknownBox(typ, sz);
        }
        return new FullBufBox(typ, sz);
    }
}

class Mp4SampleReader {
    constructor(track, mdatOffset) {
        this.stsc = track.findByType('stsc');
        this.stss = track.findByType('stss');
        this.stsz = track.findByType('stsz');
        this.stco = track.findByType('stco');
        this.stts = track.findByType('stts');
        this.ctts = track.findByType('ctts');
        let mdhd = track.findByType('mdhd');
        this.timeScale = mdhd.version ? mdhd.r32(16) : mdhd.r32(8); // TODO
        this.position = 0;
        this.readOffset = 0;
        this.lastChunk = -1;
        this.mdatOffset = mdatOffset || 0;
    }
    isEos() { return this.position >= this.stsz.count(); }
    isSyncPoint() { return (this.stss == null) || this.stss.include(this.position + 1); }
    currentChunk() { return this.stsc.sampleToChunk(this.position); }
    seek(sample) {
        this.lastChunk = this.stsc.sampleToChunk(sample);
        this.position = sample;
        this.readOffset = 0;
        while (sample > 0) {
            sample--;
            if (this.stsc.sampleToChunk(sample) != this.lastChunk) break;
            this.readOffset += this.stsz.sampleSize(sample);
        }
    }
    readSampleInfo() {
        let chunk = this.currentChunk();
        if (this.lastChunk != chunk) {
            this.lastChunk = chunk;
            this.readOffset = 0;
        }
        let sampleInfo = {
            timestamp: this.stts.sampleToTime(this.position),
            timeOffset: this.ctts ? this.ctts.sampleToOffset(this.position) : null,
            syncPoint: this.isSyncPoint(),
            size: this.stsz.sampleSize(this.position),
            offset: this.stco.offset(chunk) + this.readOffset - this.mdatOffset,
            chunk: chunk,
        };
        this.readOffset += sampleInfo.size;
        this.position++;
        return sampleInfo;
    }
}

class Mp4FragmentBuilder {
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
    build(data, offset) {
        let moof = new SimpleBoxList("moof", 0);
        let mfhd = new BoxMFHD();
        mfhd.sequenceNumber = this.seq;
        moof.children.push(mfhd);
        let traf = new SimpleBoxList("traf", 0);
        moof.children.push(traf);
        let tfhd = new BoxTFHD();
        tfhd.flags |= BoxTFHD.FLAG_DEFAULT_SIZE | BoxTFHD.FLAG_DEFAULT_FLAGS; // ffmpeg compat
        tfhd.defaultSize = 0;
        tfhd.defaultFlags = SAMPLE_FLAGS_NO_SYNC;
        tfhd.trackId = this.track;
        tfhd.defaultDuration = (this.duration() / (this.samples.length - 1)) | 0;
        traf.children.push(tfhd);

        let tfdt = new BoxTFDT();
        tfdt.flagStart = this.samples[0].timestamp;
        traf.children.push(tfdt);
        let trun = new BoxTRUN();
        traf.children.push(trun);
        trun.flags = BoxTRUN.FLAG_SAMPLE_SIZE | BoxTRUN.FLAG_SAMPLE_FLAGS
            | BoxTRUN.FLAG_SAMPLE_CTS | BoxTRUN.FLAG_DATA_OFFSET;

        let mdat = new UnknownBox('mdat', this.totalSize + 8);
        let pos = 0;
        this.samples.forEach(sample => {
            trun.add(sample.size);
            trun.add(sample.syncPoint ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NO_SYNC);
            trun.add(sample.timeOffset);
            mdat.bytes.set(data.slice(sample.offset - offset, sample.offset - offset + sample.size), pos);
            pos += sample.size;
        });
        trun.dataOffset = moof.updateSize() + 8;

        let box = new MP4Container();
        box.children.push(moof);
        box.children.push(mdat);
        return box;
    }
}

class MP4Player {
    constructor(videoEl) {
        this.videoEl = videoEl;
        this.codecs = [];
    }
    async playBufferedReader(br) {
        let perser = new MP4Container();
        let mdatOffset = 8;
        let readers = [];
        let foundMoof = 0;
        let mdatBox = null;
        let mdatPos = 0;
        let seq = 0;
        let readSegment = async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // delay for debug.
            let output = new MP4Container();
            let boxes = output.children;
            if (foundMoof) {
                let b1 = await perser.parseBox(br); // moof
                let b2 = await perser.parseBox(br); // mdat
                b1 && boxes.push(b1);
                b2 && boxes.push(b2);
                seq++;
            } else if (mdatBox == null) {
                let b;
                while ((b = await perser.peekNextBox(br)) != null) {
                    if (b.type == 'mdat') {
                        mdatBox = b;
                        readers.forEach(r => r.mdatOffset = mdatOffset);
                        break;
                    } else if (b.type == 'moof') {
                        foundMoof = true;
                        break;
                    }
                    await perser.parseBox(br);
                    mdatOffset += b.size;
                    if (b.type == 'moov') {
                        let tracks = b.findByTypeAll("trak", []);
                        readers = tracks.map(t => new Mp4SampleReader(t));
                        this.codecs = this._getCodecs(tracks);
                        this._clearMoov(b, tracks);
                    }
                    boxes.push(b);
                }
            } else {
                let trackId = seq % readers.length + 1;
                let reader = readers[trackId - 1];
                let builder = new Mp4FragmentBuilder(trackId, ++seq);
                let minDuration = 5 * reader.timeScale;
                while (builder.duration() < minDuration && !reader.isEos()) {
                    builder.addSample(reader.readSampleInfo());
                    // console.log(sample);
                }
                let mdatStart = builder.mdatStart;
                let mdatEnd = builder.mdatEnd;
                if (builder.duration() > 0) {
                    if (mdatPos > mdatStart) {
                        br.seek(mdatOffset + mdatStart);
                        mdatPos = mdatStart;
                        console.warn('seeking... TODO: keep buffer');
                    } else if (mdatPos < mdatStart) {
                        console.log(mdatStart, mdatPos);
                        let dummy = new Uint8Array(mdatStart - mdatPos);
                        await br.bufferAsync(dummy.length);
                        br.readBytesTo(dummy);
                        mdatPos = mdatStart;
                    }
                    let data = new Uint8Array(mdatEnd - mdatStart);
                    await br.bufferAsync(data.length);
                    mdatPos += data.length;
                    br.readBytesTo(data);
                    output = builder.build(data, mdatStart);
                }
            }
            if (output.children.length == 0) {
                return null;
            }
            let w = new BufferWriter(output.updateSize() - 8);
            console.log(output, output.updateSize());
            await output.write(w);
            //if (seq == 1) {
            //    let br = new BufferedReader();
            //    br.appendBuffer(w.buffer);
            //    console.log(await new MP4Container("", 0xfffffff).parse(br));
            //    document.body.innerHTML += "<a href=" + URL.createObjectURL(new Blob([w.bytes.slice()])) + ">segment " + seq + " </a><br />";
            //}
            return w.buffer;
        }
        let buffer = await readSegment();
        if (buffer == null) {
            throw 'cannnot read init segment';
        }

        let mimeCodec = 'video/mp4; codecs="' + this.codecs.join(",") + '"';
        console.log(mimeCodec);
        if (!MediaSource.isTypeSupported(mimeCodec)) {
            throw 'Unsupported MIME type or codec: ' + mimeCodec;
        }

        let mediaSource = new MediaSource();
        this.videoEl.src = URL.createObjectURL(mediaSource);

        await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
        let sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

        sourceBuffer.addEventListener('updateend', async () => {
            let buffer = await readSegment();
            if (buffer == null) {
                mediaSource.endOfStream();
            } else {
                sourceBuffer.appendBuffer(buffer);
            }
        });
        sourceBuffer.appendBuffer(buffer);

    }
    _readSegment() {

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
            // console.log(stbl.children);
            // TODO
            stbl.children = [
                stbl.findByType("stsd"),
                new FullBufBox("stts", 16),
                new FullBufBox("stsc", 16),
                new FullBufBox("stsz", 20),
                new FullBufBox("stco", 16),
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

window.addEventListener('DOMContentLoaded', async (ev) => {
    let videoEl = document.querySelector('video');
    let videoUrl = 'videos/bunny.mp4';

    videoEl.addEventListener('error', ev => console.log('error', ev));

    let options = {
        opener: {
            async open(pos) {
                return (await fetch(videoUrl, pos ? { headers: { 'range': 'bytes=' + pos + '-' } } : {})).body.getReader();
            }
        }
    };
    new MP4Player(videoEl).playBufferedReader(new BufferedReader(options));
}, { once: true });
