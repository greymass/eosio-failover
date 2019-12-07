import * as needle from 'needle'

interface SlackMessage {
    text: string
    channel?: string
}

export class SlackWebhook {

    constructor(private url: string, private channel?: string, private chain?: string) {}

    public async send(message: string | any) {
        if (!this.url) return
        let msg: SlackMessage
        if (typeof message === 'string') {
            msg = {
              text: `[${this.chain}] ${message}`,
              channel: this.channel
            }
        } else {
            msg = message
        }
        return needle('post', this.url, msg, {json: true})
    }

}
