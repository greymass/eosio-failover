import * as config from 'config'
import * as _ from 'lodash'
import { logger, slack } from './common'
import { JsonRpc, Api } from 'eosjs'
import { JsSignatureProvider } from 'eosjs/dist/eosjs-jssig'
import version from './version'

const fetch = require('node-fetch')
const util = require('util')
const textEncoder = new util.TextEncoder()
const textDecoder = new util.TextDecoder()

const signatureProvider = new JsSignatureProvider([config.get('regproducer_key')])
const rpc = new JsonRpc(config.get('api'), { fetch })
const eos = new Api({
  rpc,
  signatureProvider,
  textDecoder,
  textEncoder,
})

const producer_account:string = config.get('producer_account')
const producer_permission:string = config.get('producer_permission')
const producer_website:string = config.get('producer_website')
const producer_location:number = config.get('producer_location')
let producer_signing_pubkeys:any = config.get('producer_signing_pubkeys')

const rounds_missed_threshold:number = config.has('rounds_missed_threshold') ? config.get('rounds_missed_threshold') : 1
const total_producers:number = config.has('total_producers') ? config.get('total_producers') : 21
const round_timer:number = (config.has('round_timer') ? Number(config.get('round_timer')) : 126) * 1000

let stuck_counter = 0
let rounds_missed = 0
let last_unpaid = -1

function throttle(num: number): boolean {
  const sqrt = Math.floor(Math.pow(num, 0.5))
  return num === sqrt * sqrt
}

export async function getChainState(): Promise<any> {
  try {
    const info = await rpc.get_info()
    return _.pick(info, [
      'head_block_num',
      'head_block_producer'
    ])
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve chain state')
      slack.send(`⚠️ Unable to get_info ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_info`)
    }
    return false
  }
}

export async function getActiveProducers(): Promise<any> {
  try {
    const results = await rpc.get_producers(true, '', total_producers)
    return { ...results.rows }
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve active producers')
      slack.send(`⚠️ Unable to retrieve active producers ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_producers`)
    }
    return false
  }
}

export async function getProducerSchedule(): Promise<any> {
  try {
    const results = await rpc.get_producer_schedule()
    return results
  } catch (e) {
    stuck_counter += 1
    if (throttle(stuck_counter)) {
      logger.warn({ stuck_counter, e }, 'unable to retrieve producer schedule')
      slack.send(`⚠️ Unable to retrieve producer schedule ${round_timer * stuck_counter} - ${config.get('api')}/v1/chain/get_producer_schedule`)
    }
    return false
  }
}

export function incomingSigningKeyChange(
  current_signing_key: string,
  schedule: any,
  state: string
): boolean {
  if (schedule[state] && schedule[state].producers) {
    const schedule_for_producer = _.find(schedule[state].producers, { producer_name: producer_account })
    if (schedule_for_producer) {
      const scheduled_new_key = schedule_for_producer.block_signing_key
      if (producer_signing_pubkeys.includes(scheduled_new_key)) {
        logger.debug({ producer_signing_pubkeys, current_signing_key }, `removing ${state} producer key from potential failover keys`)
        producer_signing_pubkeys = _.filter(producer_signing_pubkeys, (k) => k !== scheduled_new_key);
      }
      if (scheduled_new_key !== current_signing_key) {
        logger.debug({ scheduled_new_key, current_signing_key }, `${state} schedule change found, awaiting...`)
        return true
      }
    }
  }
  return false
}

export async function failover(next_signing_key: string): Promise<string> {
  const result = await eos.transact({
    actions: [
      {
        authorization: [{
          actor: producer_account,
          permission: producer_permission,
        }],
        account: 'eosio',
        name: 'regproducer',
        data: {
          location: producer_location,
          producer: producer_account,
          producer_key: next_signing_key,
          url: producer_website,
        },
      }
    ]
  }, {
    blocksBehind: 3,
    expireSeconds: 60,
  });
  return result.transaction_id
}

export async function unregister(): Promise<string> {
  const result = await eos.transact({
    actions: [
      {
        authorization: [{
          actor: producer_account,
          permission: producer_permission,
        }],
        account: 'eosio',
        name: 'unregprod',
        data: {
          producer: producer_account
        },
      }
    ]
  }, {
    blocksBehind: 3,
    expireSeconds: 60,
  });
  return result.transaction_id
}

export async function check() {
  // Retrieve the current state of the blockchain
  const state = await getChainState()
  if (!state) return

  // Get the active block producers
  const producers = await getActiveProducers()
  if (!producers) return

  // Get the current producer schedule
  const schedule = await getProducerSchedule()
  if (!schedule) return

  // Get the target producer from the active producers
  const producer = _.find(producers, { owner: producer_account })
  if (!producer) {
    logger.debug({ producer_account }, `producer not an active producer`)
    return
  }

  // Get the target producer within the schedule
  const current_schedule = _.find(schedule.active.producers, { producer_name: producer_account })
  if (!current_schedule) {
    logger.debug({ producer_account }, `producer not in schedule`)
    return
  }

  // Get the current signing key from the active schedule
  const current_signing_key = current_schedule.block_signing_key;

  // Ensure the current key in use is not a potential key to failover to
  if (producer_signing_pubkeys.includes(current_signing_key)) {
    logger.debug({ producer_signing_pubkeys, current_signing_key }, "removing current signing key from potential failover keys")
    producer_signing_pubkeys = _.filter(producer_signing_pubkeys, (k) => k !== current_signing_key);
  }

  // If a key change is in progress, do not proceed
  if (
    incomingSigningKeyChange(current_signing_key, schedule, 'proposed')
    || incomingSigningKeyChange(current_signing_key, schedule, 'pending')
  ) {
    // reset the last paid value to reinitiaize and prevent secondary trigger under certain circumstances
    last_unpaid = -1
    slack.send(`🕒 signing key changes pending in schedule`)
    return
  }

  let { unpaid_blocks } = producer
  logger.debug({ unpaid_blocks, last_unpaid }, "unpaid block states")

  if (last_unpaid === -1) {
    // If this is the first run (-1), just initialize and don't proceed
    logger.info({ unpaid_blocks }, "initializing unpaid block count on first call")
    last_unpaid = unpaid_blocks
    return
  } else if (unpaid_blocks < last_unpaid) {
    // If the new unpaid is less than the old, the BP has claimed and this value needs to be reset
    logger.debug({ last_unpaid, unpaid_blocks }, "resetting unpaid blocks, encountered reward claim")
    last_unpaid = unpaid_blocks
    return
  } else if (unpaid_blocks > last_unpaid) {
    // If the unpaid count is higher than the old count, new blocks were produced
    const newBlocks = unpaid_blocks - last_unpaid
    logger.info({ last_unpaid, unpaid_blocks }, `round success, witnessed ${newBlocks} new unpaid blocks`)
    // Update the last unpaid value
    last_unpaid = unpaid_blocks
    // If any previously recorded rounds were recorded, reset them
    if (rounds_missed > 0) {
      const msg = `producer recovered after ${rounds_missed} rounds, witnessed ${newBlocks} new unpaid blocks`
      logger.info({ rounds_missed }, msg)
      slack.send(msg)
      rounds_missed = 0
    }
  } else if (unpaid_blocks === last_unpaid) {
    // If the unpaid blocks is the same as the last time - no new blocks have been produced
    rounds_missed += 1
    logger.info({ last_unpaid, unpaid_blocks, rounds_missed }, `producer missed a round!`)
    slack.send(`⚠️ producer missed a round ${rounds_missed}/${rounds_missed_threshold}`)
  }

  // If the new missed rounds exceeds the threshold, begin taking action
  if (rounds_missed >= rounds_missed_threshold) {
    logger.debug({ rounds_missed, rounds_missed_threshold }, 'producer has exceeded missed round threshold, executing failover')
    slack.send(`⚠️ producer exceeded missed round threshold ${rounds_missed}/${rounds_missed_threshold}`)
    // If keys exist, failover to one of them
    try {
      if (Array.isArray(producer_signing_pubkeys) && producer_signing_pubkeys.length) {
        const next_signing_key = producer_signing_pubkeys.shift()
        const txid = await failover(next_signing_key)
        logger.info({ txid, next_signing_key }, 'regproducer submitted to failover to next available node')
        slack.send(`⚠️ regproducer submitted with new signing key of ${next_signing_key}, ${producer_signing_pubkeys} keys remaining in rotation (${txid})`)
      } else {
        // If no public keys exist, unregister the BP
        const txid = await unregister()
        logger.info({ txid }, 'unregprod submitted')
        slack.send(`⚠️ producer has no backup nodes available, unregprod submitted (${txid})`)
      }
    } catch(e) {
      const txid = await unregister()
      logger.info({ txid, e }, 'failure to rotate/unregprod, new unregprod submitted')
      slack.send(`⚠️ failure to rotate/unregprod, unregprod submitted (${txid})`)
    }
  }
}

export async function main() {
  // Initialize with a first check
  check()
  // Run the check on a set interval based on the length of a round
  setInterval(check, round_timer)
}

function ensureExit(code: number, timeout = 3000) {
  process.exitCode = code
  setTimeout(() => { process.exit(code) }, timeout)
}

if (module === require.main) {
  process.once('uncaughtException', (error) => {
    logger.error(error, 'Uncaught exception')
    ensureExit(1)
  })
  main().catch((error) => {
    logger.fatal(error, 'Unable to start application')
    ensureExit(1)
  })
}
