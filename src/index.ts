import { config } from 'dotenv';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from './logger';

config();

const main = async (argv: string[]) => yargs(hideBin(argv))
  .scriptName('')
  .usage('Usage: npm start -- <command> [options]')
  .version(false)
  .strictCommands(true)
  .env('DS')
  .config('config')
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
    () => { throw new Error('Example error message'); },
  )
  .demandCommand()
  .parse();

main(process.argv)
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Error encountered while running `main`');
    process.exit(1);
  });
