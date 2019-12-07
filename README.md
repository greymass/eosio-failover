## Best Practices

Your various block producer nodes...

- SHOULD all have unique keys, with each public key loaded into the failover solution
- SHOULD NOT run on the same server as the failover
- SHOULD NOT all be in the same data center

This failover solution...

- SHOULD specify the most reliable API endpoint possible (load balanced API when available)
- SHOULD be integrated with notification methods your organization uses
- SHOULD NOT run in the same server or data center as the API endpoint being used
- SHOULD NOT run in the same server or data center as your block production node
- SHOULD NOT be run with an `regproducer_key` which is either a `active` or `owner` key

## Configuration

Establish your configuration file by copying the default configuration and then modifying it.

```
cp config/default.toml config/local.toml
```

Edit `config/local.toml` with the appropriate values for your producer. This file is ignored by git and will retain your settings through upgrades.

- `name`: Internal name of the application for bunyan logging
- `api`: EOSIO API (standard) from which to retrieve information.
- `rounds_missed_threshold`: The number of rounds the script will tolerate before moving to the next key.
- `regproducer_key`: The private key which can sign both `eosio::regproducer` and `eosio::unregprod`.
- `producer_account`: The producer account to monitor and issue failover commands for.
- `producer_permission`: The permission name of the private key associated with `regproducer_key`.
- `producer_website`: The website address of the producer you'd like to broadcast with `eosio::regproducer`.
- `producer_location`: The numeric country code of the producer you'd like to broadcast with `eosio::regproducer`.
- `producer_signing_pubkeys`: An array of valid public keys assigned to different production nodes.
- `slack` (OPTIONAL): Object containing a `url` of a Slack Webhook to broadcast messages, a `channel` to specify the target, and a `chain` to identify which blockchain the messages are in regards to.
- `level` (OPTIONAL): The output level of the logger.
- `out` (OPTIONAL): The output method of the logger.

## Running

After the configuration has been set and the example values replaced, there are multiple ways to run this service:

#### nodejs

In order to run this script, you will have to compile the TypeScript and then run the resulting javascript.

```
make lib
node lib/app.js
```

You should be able to run this script with any nodejs based process handler or from within a tmux session.

#### docker + docker-compose

A `docker` and `docker-compose` configuration has been provided to make deployment as simple as possible.

If you need to install either, refer to the following guides:

- [How To Install and Use Docker on Ubuntu 18.04 (DigitalOcean)](https://www.digitalocean.com/community/tutorials/how-to-install-and-use-docker-on-ubuntu-18-04)
- [How To Install Docker Compose on Ubuntu 18.04 (DigitalOcean)](https://www.digitalocean.com/community/tutorials/how-to-install-docker-compose-on-ubuntu-18-04)

To run the failover script within `docker` using `docker-compose`, navigate into the root folder of this repository and run:

```
docker-compose build
docker-compose up -d
```

Verify its running:

```
docker-compose ps
```

Tailing the logs:

```
docker-compose logs -f --tail="200"
```

To stop the script:

```
docker-compose down
```

## Upgrading

The upgrade process from the latest version on github.com should be simple as:

```
docker-compose stop
git pull
docker-compose build
```

## Development

To develop with this repository, setup the configuration as shown above and then run:

```
make dev
```
