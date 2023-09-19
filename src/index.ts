import { config } from 'dotenv';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { candid } from './candid';
import { logger } from './logger';
import { getTokenCommand } from './oidc';

config();

const main = async (argv: string[]) => yargs(hideBin(argv))
  .scriptName('')
  .usage('Usage: npm start -- <command> [options]')
  .version(false)
  .strictCommands(true)
  .env('DS')
  .config('config')
  .fail((msg, err, y) => {
    logger.fatal({ m: msg, err, yargs: y }, 'Error encountered');
  })
  .command(
    ['show-args', 'args'],
    'Show the options that have been parsed from the environment, config files, and command line arguments',
    {},
    (args) => { logger.info({ args }, 'Parsed arguments'); },
  )
  .command(
    'error',
    'Throw an error to see how it is handled',
    {},
    async () => { throw new Error('Example error message'); },
  )
  .command(getTokenCommand)
  .command(candid)
  .demandCommand()
  .parse();

main(process.argv)
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Error encountered while running `main`');
    process.exit(1);
  });
