import "regenerator-runtime/runtime";
import {AdapterNvMemory} from '../../../src/adapter/z-stack/adapter/adapter-nv-memory';
import {NvItemsIds} from '../../../src/adapter/z-stack/constants/common';

describe('AdapterNvMemory', () => {
    it('readItem rethrows when every retry fails, instead of reporting the item absent', async () => {
        const request = jest.fn().mockRejectedValue(new Error('SRSP timeout'));
        const nv = new AdapterNvMemory({request} as any);

        await expect(nv.readItem(NvItemsIds.NIB)).rejects.toThrow('SRSP timeout');
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('readItem succeeds when a retry succeeds', async () => {
        const request = jest.fn()
            .mockRejectedValueOnce(new Error('SRSP timeout'))
            .mockResolvedValueOnce({payload: {length: 2}})
            .mockResolvedValueOnce({payload: {status: 0, value: Buffer.from([1, 2])}});
        const nv = new AdapterNvMemory({request} as any);

        await expect(nv.readItem(NvItemsIds.NIB)).resolves.toEqual(Buffer.from([1, 2]));
    });

    it('readItem still returns null for an absent item', async () => {
        const request = jest.fn().mockResolvedValue({payload: {length: 0}});
        const nv = new AdapterNvMemory({request} as any);

        await expect(nv.readItem(NvItemsIds.NIB)).resolves.toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
    });
});
