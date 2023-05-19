# data-scripts

Command-line scripts to add data to a PDC service instance.

## Separate scripts

Some scripts have individual `npm run-script` commands.
To list scripts, use `npm run`.

Run a script with a `--` between the name and its arguments:

`npm run [script name] -- --[parameter name]=[arg]`

To find information on one of these scripts,
look in the script itself at `src/[script name].ts`.

## Unified scripts

Additional scripts are created as subcommands of a single, unified script.
Run it with `npm start` to see the list of commands and required options.
Pass arguments with a `--` between the name and its arguments: `npm start -- help`.

Options to the unified scripts can be given in a few different ways.

Environment variables - including those specified in `.env` -
are loaded if they start with `DS_`.
Copy the `.env.example` to `.env`, edit, and run the script.

Configuration files can be used
to specify groups of options that change together.
An important use case we want to support is easily
running against different instances of the PDC API.
Copy the `config.example.json` file, edit it,
and pass the filename to the script:

```
npm start -- --config config.prod.json args
```

The `.env` file and `config.*.json` files are ignored by git,
as they likely contain credentials and should not be committed.

Finally, every option can be specified on the command line itself.
