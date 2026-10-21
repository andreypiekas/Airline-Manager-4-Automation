'use strict';
const fs = require('node:fs');

function booleanValue(raw, name) {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} deve ser true ou false.`);
}

function nonNegativeIntegerValue(raw, name) {
  const value = (raw || '').trim();
  if (!value) return null;

  // Inputs type:number do GitHub Actions podem chegar como "0.0"/"20.0".
  // Aceitamos apenas representacoes decimais matematicamente inteiras.
  // Fracoes, expoentes, sinais e valores ambiguos continuam bloqueados.
  if (!/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value)) {
    throw new Error(`${name} deve ser inteiro nao negativo.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} deve ser inteiro nao negativo.`);
  }
  return parsed;
}

/** No credentials: resolve manual/API inputs and explicitly configured repository policy. */
function resolveDepartureSettings(env) {
  const mode = (env.AM4_INPUT_MODE || 'repository').trim();

  if (!['repository', 'simulation', 'production'].includes(mode)) {
    throw new Error('departure_mode invalido.');
  }

  const inputExecute = booleanValue(env.AM4_INPUT_EXECUTE, 'input execute');
  const repositoryExecute = booleanValue(env.AM4_REPOSITORY_EXECUTE, 'EXECUTE_INDIVIDUAL');
  const semiAutomatic = booleanValue(env.AM4_SEMI_AUTOMATIC, 'SEMI_AUTOMATIC_MODE');
  const semiConfirm = booleanValue(env.AM4_SEMI_CONFIRM, 'confirm_semiautomatic_execution');
  const semiConfirmed = semiAutomatic && semiConfirm;
  const dispatchAllReady = booleanValue(env.AM4_DISPATCH_ALL_READY, 'DISPATCH_ALL_READY');

  const requestedExecute =
    mode === 'production' ||
    (mode === 'repository' && (inputExecute || repositoryExecute));
  const execute = requestedExecute && (!semiAutomatic || semiConfirmed);

  const modeSource =
    semiAutomatic && !semiConfirmed
      ? 'variable:SEMI_AUTOMATIC_MODE'
      : semiConfirmed
        ? 'input:confirm_semiautomatic_execution'
        : mode !== 'repository'
          ? `input:${mode}`
          : inputExecute
            ? 'input:execute'
            : repositoryExecute
              ? 'variable:EXECUTE_INDIVIDUAL'
              : 'default:simulation';

  // O input 0 (inclusive quando serializado como 0.0) significa
  // "usar configuracao do repositorio".
  const inputLimit = nonNegativeIntegerValue(env.AM4_INPUT_MAX_DEPARTURES, 'Limite manual de decolagens');
  const repositoryLimit = nonNegativeIntegerValue(env.AM4_REPOSITORY_MAX_DEPARTURES, 'Limite do repositorio');
  const useRepositoryLimit = inputLimit === null || inputLimit === 0;

  let maxDepartures;
  let limitSource;

  if (!useRepositoryLimit) {
    // Explicit manual caps always win, including a deliberate limit of 1.
    maxDepartures = inputLimit;
    limitSource = 'input:limit';
  } else if (dispatchAllReady && execute) {
    // Opt-in via workflow/repository variable: evaluate all ready aircraft.
    // The executor still stops on deadline, fuel, demand, identity and uncertainty.
    maxDepartures = 100;
    limitSource = 'variable:DISPATCH_ALL_READY';
  } else if (repositoryLimit === null || repositoryLimit === 0) {
    maxDepartures = 1;
    limitSource = 'default:1';
  } else {
    maxDepartures = repositoryLimit;
    limitSource = 'variable:MAX_INDIVIDUAL_DEPARTURES';
  }

  if (!Number.isSafeInteger(maxDepartures) || maxDepartures < 1 || maxDepartures > 100) {
    throw new Error('Limite de decolagens deve ser inteiro de 1 a 100.');
  }

  const automationMode = semiAutomatic && !semiConfirmed
    ? 'semi-automatic'
    : execute
      ? 'production'
      : 'simulation';

  return {
    dryRun: !execute,
    maxDepartures,
    modeSource,
    limitSource,
    semiAutomatic,
    semiConfirmed,
    automationMode
  };
}

function main(env = process.env) {
  const settings = resolveDepartureSettings(env);

  if (!env.GITHUB_OUTPUT) {
    throw new Error('GITHUB_OUTPUT ausente.');
  }

  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `dry_run=${settings.dryRun}\nmax_departures=${settings.maxDepartures}\nautomation_mode=${settings.automationMode}\nsemi_automatic=${settings.semiAutomatic}\nsemi_confirmed=${settings.semiConfirmed}\n`
  );

  console.log('[DepartureConfig] ' + JSON.stringify(settings));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[DepartureConfig] ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveDepartureSettings, main };
