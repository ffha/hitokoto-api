const Koa = require('koa')
const chalk = require('chalk')
const nconf = require('nconf')
const app = new Koa()
// Load Route
async function registerRoutes(routes) {
  const { logger } = require('./logger')
  try {
    await routes
      .then((router) => {
        app.use(router.routes()).use(router.allowedMethods())
      })
      .catch((err) => {
        logger.error(chalk.red(err.stack))
        // mail.error(err)
        process.exit(1)
      })
    logger.verbose('[init] koa routes are loaded.')
  } catch (e) {
    logger.error(chalk.red(e.stack))
    // mail.error(e)
    process.exit(1)
  }
}
async function StartWebServer(isDev, netSocketHandle) {
  await require('./middleware').register(app, isDev) // Register middlewares
  const Routes = require('./route')
  await registerRoutes(new Routes().routes())
  // TODO: optimize tracing entrypoint
  const { Sentry } = require('./tracing')
  const isTelemetryErrorEnabled = nconf.get('telemetry:error')
  if (isTelemetryErrorEnabled && !isDev) {
    app.on('error', (err, ctx) => {
      Sentry.withScope(function (scope) {
        scope.addEventProcessor(function (event) {
          return Sentry.Handlers.parseRequest(event, ctx.request)
        })
        Sentry.captureException(err)
      })
    })
  }
  app.listen(netSocketHandle)
}

function notifyMasterWorkerStarted() {
  const { send } = require('./utils/worker/ipc')
  send({
    key: 'started',
  })
}

// PreStart
const { loadAsync } = require('./prestart')
const isDev = process.env?.dev === 'true'
const configFile = process.env?.config_file

process.on('uncaughtException', function (err) {
  const nconf = require('nconf')
  const { logger } = require('./logger')
  const { Sentry } = require('./tracing')
  logger.error(`uncaughtException: ${err.stack}`)
  if (nconf.get('telemetry:error') && !isDev) {
    Sentry.captureEvent(err)
  }
  process.exit(1)
})

process.on('message', ({ key, data }, netSocketHandle) => {
  if (key === 'server_handle') {
    loadAsync(configFile, true, isDev)
      .then(async () => {
        await StartWebServer(isDev, netSocketHandle)
      })
      .finally(() => {
        const { logger } = require('./logger')
        logger.verbose('[web.Worker] server worker is started successfully.')
        notifyMasterWorkerStarted()
      })
      .catch((err) => {
        const { logger } = require('./logger')
        logger.error(
          `[web.Worker] can't start worker. err detail: \n ${err.stack}`,
        )
        process.exit(1)
      })
  } else if (key === 'switchAB') {
    const { logger } = require('logger')
    logger.verbose(
      `[web.Worker] pid: ${
        process.pid
      } received AB switch signal, switching to: ${chalk.blue(data)}`,
    )
    const AB = require('./extensions/sentencesABSwitcher')
    AB.setDatabase(data)
  }
})
