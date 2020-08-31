"use strict";
class BufferedReader {
    constructor(options = {}) {
        this.reader = options.reader || null;
        this.opener = options.opener || null;
        this.littleEndian = false;
        this.buffers = [];
        this.bufferdSize = 0;
        this.position = 0;

        this.currentBuffer = null;
        this.currentDataView = null;
        this.currentBufferPos = 0;
        this.currentRemainings = 0;

        this.tmpBuffer = new ArrayBuffer(8);
        this.tmpDataView = new DataView(this.tmpBuffer);
        this.tmpBytes = new Uint8Array(this.tmpBuffer);
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
        this.currentRemainings = 0;
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
        this.buffers.push(buffer);
        this.bufferdSize += buffer.byteLength;
        this._checkCurrentBuffer();
    }
    _checkCurrentBuffer() {
        if (this.currentRemainings <= 0) {
            this.bufferdSize -= this.currentBuffer ? this.currentBuffer.byteLength : 0;
            this.currentBuffer = this.buffers.shift();
            this.currentDataView = new DataView(this.currentBuffer);
            this.currentRemainings = this.currentBuffer.byteLength;
            this.currentBufferPos = 0;
        }
    }
    _getDataView(n) {
        if (this.available() < n) {
            throw "no buffered data";
        }
        this._checkCurrentBuffer();
        if (this.currentRemainings >= n) {
            return [this.currentDataView, this._proceed(n)];
        }
        this.readBytesTo(this.tmpBytes, 0, n);
        return [this.tmpDataView, 0];
    }
    _proceed(n) {
        this.currentRemainings -= n;
        return (this.currentBufferPos += n) - n;
    }
    readBytesTo(bytes, offset, size) {
        offset = offset || 0;
        size = size || bytes.length - offset;
        let p = 0;
        while (p < size) {
            this._checkCurrentBuffer();
            let l = Math.min(size - p, this.currentRemainings);
            bytes.set(new Uint8Array(this.currentBuffer, this._proceed(l), l), offset + p);
            p += l;
        }
        return bytes;
    }
    readData(len) {
        let result = [];
        let p = 0;
        while (p < len) {
            this._checkCurrentBuffer();
            let l = Math.min(len - p, this.currentRemainings);
            result.push(new Uint8Array(this.currentBuffer, this._proceed(l), l));
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
        let count = this.count();
        let t = 0;
        for (let i = 0; i < count; i++) {
            let c = this.count1(i), d = this.delta(i);
            if (n < c) {
                return t + n * d;
            }
            n -= c;
            t += c * d;
        }
        return t;
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

const SAMPLE_FLAGS_NO_SYNC = 0x01010000;
const SAMPLE_FLAGS_SYNC = 0x02000000;
const CONTAINER_BOX = new Set(["moov", "trak", "dts\0", "mdia", "minf", "stbl", "udta", "moof", "traf", "edts", "mvex"]);
const BOXES = {
    "stco": BoxSTCO, "stsc": BoxSTSC, "stsz": BoxSTSZ, "stss": BoxSTSS, "stts": BoxSTTS, "ctts": BoxCTTS,
    "tfdt": BoxTFDT, "trex": BoxTREX, "trun": BoxTRUN, "mdhd": FullBufBox, "stsd": FullBufBox,
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
        return new UnknownBox(typ, sz);
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
    isSyncPoint(position) { return (this.stss == null) || this.stss.include(position + 1); }
    currentChunk() { return this.stsc.sampleToChunk(this.position); }
    seekPosition(position) {
        this.lastChunk = this.stsc.sampleToChunk(position);
        this.position = position;
        this.readOffset = 0;
        while (position > 0) {
            position--;
            if (this.stsc.sampleToChunk(position) != this.lastChunk) break;
            this.readOffset += this.stsz.sampleSize(position);
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
        let chunk = this.currentChunk();
        if (this.lastChunk != chunk) {
            this.lastChunk = chunk;
            this.readOffset = 0;
        }
        let sampleInfo = {
            timestamp: this.stts.sampleToTime(this.position),
            timeOffset: this.ctts ? this.ctts.sampleToOffset(this.position) : null,
            syncPoint: this.isSyncPoint(this.position),
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

        let box = new SimpleBoxList();
        box.children.push(moof);
        box.children.push(mdat);
        return box;
    }
}

class MP4Player {
    constructor(videoEl, options = {}) {
        this.videoEl = videoEl;
        this.segmentDuration = options.segmentDuration || 5;
        this.codecs = [];
        this.fragmented = false;
    }
    async setBufferedReader(br) {
        let perser = new MP4Container();
        let mdatOffset = 8;
        let readers = [];
        let mdatBox = null;
        let mdatPos = 0;
        let mdatLast = null;
        let segmentSeq = 0;
        let readSegment = async () => {
            await new Promise(resolve => setTimeout(resolve, 500)); // delay for debug.
            let output = new MP4Container();
            let boxes = output.children;
            if (this.fragmented) {
                let b1 = await perser.parseBox(br); // moof
                let b2 = await perser.parseBox(br); // mdat
                b1 && boxes.push(b1);
                b2 && boxes.push(b2);
                segmentSeq++;
            } else if (mdatBox == null) {
                let b;
                while ((b = await perser.peekNextBox(br)) != null) {
                    if (b.type == 'mdat') {
                        mdatBox = b;
                        readers.forEach(r => r.mdatOffset = mdatOffset);
                        break;
                    } else if (b.type == 'moof') {
                        this.fragmented = true;
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
                let trackId = segmentSeq % readers.length + 1;
                let reader = readers[trackId - 1];
                let segmentEnd = ((segmentSeq / readers.length | 0) + 1)
                    * this.segmentDuration * reader.timeScale;
                let builder = new Mp4FragmentBuilder(trackId, ++segmentSeq);
                while (builder.lastTimestamp < segmentEnd && !reader.isEos()) {
                    builder.addSample(reader.readSampleInfo());
                }
                let mdatStart = builder.mdatStart;
                let mdatEnd = builder.mdatEnd;
                if (builder.duration() > 0) {
                    if (mdatStart > mdatPos && mdatStart - mdatPos < 1024 * 1024) {
                        mdatStart = mdatPos;
                    }
                    let data = new Uint8Array(mdatEnd - mdatStart);
                    let mdatLastLen = mdatLast ? mdatLast.byteLength : 0;
                    let dataOffset = 0;
                    if (mdatPos - mdatLastLen > mdatStart || mdatStart > mdatPos) {
                        br.seek(mdatOffset + mdatStart);
                        console.warn('seeking...');
                    } else if (mdatPos > mdatStart) {
                        if (mdatEnd < mdatPos) {
                            mdatEnd = mdatPos;
                            data = new Uint8Array(mdatEnd - mdatStart); // TODO
                        }
                        dataOffset = mdatPos - mdatStart;
                        data.set(mdatLast.slice(mdatLastLen - dataOffset), 0);
                    }
                    await br.bufferAsync(data.length - dataOffset);
                    br.readBytesTo(data, dataOffset);
                    output = builder.build(data, mdatStart);
                    mdatPos = mdatEnd;
                    mdatLast = data;
                }
            }
            if (output.children.length == 0) {
                return null;
            }
            let w = new BufferWriter(output.updateSize() - 8);
            await output.write(w);
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

        this.videoEl.addEventListener('seeking', ev => {
            if (mediaSource.readyState == 'open') {
                let t = Math.max(0, this.videoEl.currentTime - this.segmentDuration / 2);
                t -= t % this.segmentDuration;
                readers.forEach(r => r.seek(t * r.timeScale));
                segmentSeq = t / this.segmentDuration * readers.length;
                sourceBuffer.abort();
            }
        });
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
