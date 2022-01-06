import * as stream from 'stream';
import {DataStart, SOF, MinMessageLength, PositionDataLength} from './constants';
import Frame from './frame';
import Debug from "debug";

const debug = Debug('zigbee-herdsman:adapter:zStack:unpi:parser');

class Parser extends stream.Transform {
    private buffer: Buffer;
    private customParser: any;

    public constructor(customParser?: any) {
        super();
        this.customParser = customParser;
        this.buffer = Buffer.from([]);
    }

    public _transform(chunk: Buffer, _: string, cb: () => void): void {
        debug(`<-- [${[...chunk]}]`);
        if (this.customParser) {
            //console.log(this.customParser);
            let znpData = this.customParser(chunk);

            if (znpData) {
                this.buffer = Buffer.concat([this.buffer, znpData]);
                this.parseNext();
            }

            cb();
        } else {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.parseNext();
            cb();
        }
    }

    private parseNext(): void {
        debug(`--- parseNext [${[...this.buffer]}]`);

        if (this.buffer.length !== 0 && this.buffer.readUInt8(0) !== SOF) {
            // Buffer doesn't start with SOF, skip till SOF.
            const index = this.buffer.indexOf(SOF);
            if (index !== -1) {
                this.buffer = this.buffer.slice(index, this.buffer.length);
            }
        }

        if (this.buffer.length >= MinMessageLength && this.buffer.readUInt8(0) == SOF) {
            const dataLength = this.buffer[PositionDataLength];
            const fcsPosition = DataStart + dataLength;
            const frameLength = fcsPosition + 1;

            if (this.buffer.length >= frameLength) {
                const frameBuffer = this.buffer.slice(0, frameLength);

                try {
                    const frame = Frame.fromBuffer(dataLength, fcsPosition, frameBuffer);
                    debug(`--> parsed ${frame}`);
                    this.emit('parsed', frame);
                } catch (error) {
                    debug(`--> error ${error.stack}`);
                }

                this.buffer = this.buffer.slice(frameLength, this.buffer.length);
                this.parseNext();
            }
        }
    }
}

export default Parser;
