import * as bunyan from 'bunyan'
import * as config from 'config'

import { SlackWebhook } from './slack-webhook'

const slackOptions:any = config.has('slack') ? config.get('slack') : {}
export const slack = new SlackWebhook(slackOptions.url, slackOptions.channel, slackOptions.chain)

const streams:any = (config.get('log') as any[]).map(({level, out}) => {
    if (out === 'stdout') {
        return {level, stream: process.stdout}
    } else if (out === 'stderr') {
        return {level, stream: process.stderr}
    } else {
        return {level, path: out}
    }
})
export const logger = bunyan.createLogger({
    name: config.get('name'),
    streams,
})
