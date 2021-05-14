import * as stream from 'stream';
import Frame from './frame';
import Debug from "debug";

const debug = Debug('zigbee-herdsman:adapter:zStack:unpi:writer');

class Writer extends stream.Readable {
    customWriter: any;

    constructor(customWriter?: any) {
        super();

        this.customWriter = customWriter;
    }

    public writeFrame(frame: Frame): void {
        const buffer = frame.toBuffer();
        debug(`--> frame [${[...buffer]}]`);
        
        if (this.customWriter) {
            this.push(this.customWriter(buffer));
        } else {
            this.push(buffer);
        }
    }

    public writeBuffer(buffer: Buffer): void {
        debug(`--> buffer [${[...buffer]}]`);

        if (this.customWriter) {
            this.push(this.customWriter(buffer));
        } else {
            this.push(buffer);
        }
    }

    public _read(): void {}
}

export default Writer;
