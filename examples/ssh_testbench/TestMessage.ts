import { randomUUID } from 'crypto';

export class TestMessage {

    public generateMessage(from: string, to: string, type: string, contents: string) {
        return {
            from: from,
            to: to,
            timestamp: new Date(),
            type: type,
            contents: (contents) ? contents : randomUUID()
        }
    }

    public signMessage(msg: string, key) {
        const s = key.createSign('sha1');
        s.update(msg);
        return s.sign();
    }

    public verifyMessage(msg: string, signature, key) {
        const v = key.createVerify('sha1');
        v.update(msg);
        return v.verify(signature);
    }
}