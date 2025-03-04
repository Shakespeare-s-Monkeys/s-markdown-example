const {
  createMachine,
  assign,
  spawn,
  interpret,
  send,
  sendParent,
} = require(`xstate`)
const util = require(`util`)
const fs = require(`fs-extra`)
const got = require(`got`)
const { parse } = require(`node-html-parser`)
const { setTimeout } = require(`timers/promises`)
const NanoTimer = require(`nanotimer`)
const prettyMilliseconds = require(`pretty-ms`)
const _ = require(`lodash`)
const Joi = require(`joi`)

const createResSchema = Joi.object({
  pagePath: Joi.string().required(),
  selector: Joi.string().required(),
  value: Joi.any().required(),
  context: Joi.object(),
})

const checkIf404 = async ({ pagePath, rootUrl }) => {
  const pageURL = `${rootUrl}${pagePath}`

  let response
  try {
    response = await got(pageURL)
  } catch (e) {
    // Ignore 404 errors and just return
    return { statusCode: e.response.statusCode }
  }

  return { statusCode: response.statusCode }
}

const checkIfDeployed = async ({ selector, pagePath, rootUrl }) => {
  const pageURL = `${rootUrl}${pagePath}`

  let response
  try {
    response = await got(pageURL)
  } catch (e) {
    // Ignore 404 errors and just return
    return { statusCode: e.response.statusCode }
  }

  const root = parse(response.body)

  const value = root.querySelector(selector)?.rawText

  return { value, statusCode: response.statusCode }
}

let idCounter = 0
function getNextId() {
  idCounter += 1
  return idCounter
}

function createEngineMachine(context) {
  if (context.nodePool?.length > 0) {
    // Set default values on the node pool.
    context.nodePool = context.nodePool.map((n) => {
      return {
        inFlight: false,
        existsOnCMS: true,
        published: true,
        ...n,
      }
    })
    context.nodePoolMode = true
    context.nodes = {}
    context.nodePool.forEach((n) => (context.nodes[n.id] = n))
  }

  return createMachine({
    id: `engine`,
    strict: true,
    initial: `running`,
    context: {
      operations: [],
      nodes: [],
      interval: 10,
      operationsLimit: 20,
      rootUrl: ``,
      createdAt: Date.now(),
      nodePool: [],
      ...context,
    },
    states: {
      running: {
        invoke: {
          src: (context) => (cb) => {
            // Create the first TICK event immediately.
            cb(`TICK`)

            // Setup next ticks based on interval choosen by config.
            const timer = new NanoTimer()
            timer.setInterval(() => cb(`TICK`), ``, `${context.interval}s`)

            return () => {
              timer.clearInterval()
            }
          },
        },
        always: [
          {
            target: `done`,
            cond: (context) => {
              const readyToBeDone =
                context.operations.length >= context.operationsLimit &&
                !context.operations.some((op) => op.state.value !== `completed`)

              // console.log(
              // context.operations.length,
              // context.operationsLimit,
              // context.operations.map((op) => op.state.value)
              // )
              // console.log(`running`, { readyToBeDone })

              return readyToBeDone
            },
          },
        ],
        on: {
          TICK: {
            actions: assign({
              operations: (context) => {
                // If we're past the limit, just return
                if (context.operations.length < context.operationsLimit) {
                  // If there's a nodePool, try picking a non-inflight node from
                  // there to update.
                  if (context.nodePoolMode) {
                    const nodeToUpdate = Object.values(context.nodes).find(
                      (n) => n.inFlight === false
                    )
                    if (nodeToUpdate) {
                      const id = getNextId()
                      const newOperation = spawn(
                        createOperationMachine({
                          id: `update-${id}`,
                          node: nodeToUpdate,
                          verb: `update`,
                          rootUrl: context.rootUrl,
                          operators: context.operators,
                        })
                      )
                      return [...context.operations, newOperation]
                    }
                    return context.operations
                  } else {
                    // If we haven't created all the nodes (1/2 of total operations),
                    // create a node.
                    if (
                      Object.keys(context.nodes).length <
                      context.operationsLimit / 2
                    ) {
                      const id = getNextId()
                      const newOperation = spawn(
                        createOperationMachine({
                          id: `create-${id}`,
                          node: {
                            id,
                          },
                          verb: `create`,
                          rootUrl: context.rootUrl,
                          operators: context.operators,
                        })
                      )
                      return [...context.operations, newOperation]
                    } else {
                      // We need to start deleting. If there's a created node,
                      // delete it, otherwise wait for the next tick.
                      const nodesToDelete = _.pickBy(
                        context.nodes,
                        (node) => node.published && !node.inFlight
                      )
                      if (!_.isEmpty(nodesToDelete)) {
                        const nodeToDelete =
                          nodesToDelete[Object.keys(nodesToDelete)[0]]

                        const newOperation = spawn(
                          createOperationMachine({
                            id: `delete-${nodeToDelete.id}`,
                            verb: `delete`,
                            rootUrl: context.rootUrl,
                            node: nodeToDelete,
                            operators: context.operators,
                          })
                        )
                        return [...context.operations, newOperation]
                      } else {
                        return context.operations
                      }
                    }
                  }
                } else {
                  return context.operations
                }
              },
            }),
          },
        },
      },
      done: {
        type: `final`,
        entry: (context) => {
          const completedAt = Date.now()
          const runTime = completedAt - context.createdAt

          console.log(`Run finished and took ${prettyMilliseconds(runTime)}`)
          console.log(
            `Average time / operation: ${prettyMilliseconds(
              _.sumBy(context.operations, (op) => op.state.context.latency) /
                context.operations.length
            )}`
          )
          // console.log(
          // `\n` +
          // asciichart.plot(
          // context.operations.map((op) => op.state.context.latency),
          // { height: 6 }
          // )
          // )
        },
      },
    },
    on: {
      NODE_UPDATED: {
        actions: assign({
          nodes: (context, event) => {
            return { ...context.nodes, [event.node.id]: event.node }
          },
        }),
      },
    },
  })
}

// TODO Split into create & delete operations
function createOperationMachine(context) {
  return createMachine({
    id: `operation`,
    strict: true,
    initial: `running`,
    context: { ...context, checks: [], checkCount: 0 },
    states: {
      running: {
        entry: sendParent((context) => {
          const action = {
            type: `NODE_UPDATED`,
            node: {
              ...context.node,
              inFlight: true,
              existsOnCMS: context.verb == `create` ? false : true,
              published: context.verb == `create` ? false : true,
            },
          }
          return action
        }),
        invoke: {
          id: `runOperation`,
          src: async (context) => {
            if (context.verb === `create`) {
              const res = await context.operators.create(context.node.id)
              const validation = createResSchema.validate(res)
              if (validation.error) {
                console.log(
                  `create operator response failed validation`,
                  validation
                )
                process.exit(1)
              }
              return res
            } else if (context.verb === `update`) {
              const updateRes = await context.operators.update(context.node)
              const validation = createResSchema.validate(updateRes)
              if (validation.error) {
                console.log(
                  `update operator response failed validation`,
                  validation
                )
                process.exit(1)
              }
              return updateRes
            } else if (context.verb === `delete`) {
              await context.operators.delete(context.node)
              return context.node
            }
          },
          onDone: {
            target: `checking`,
            actions: [
              assign({
                node: (context, event) => {
                  return { ...context.node, ...event.data }
                },
                createdAt: Date.now(),
              }),
              sendParent((_, event) => {
                const action = {
                  type: `NODE_UPDATED`,
                  node: {
                    ...context.node,
                    ...event.data,
                    inFlight: true,
                    existsOnCMS: context.verb == `create` ? true : false,
                    published: context.verb == `create` ? false : true,
                  },
                }
                return action
              }),
            ],
          },
          onError: {
            target: `failure`,
            actions: assign({
              error: (context, event) => {
                console.log(`failure`, event, { context })
                return event.data
              },
            }),
          },
        },
      },
      checking: {
        invoke: {
          id: `checkOperationCompleted`,
          src: (context, event) => async (callback, onReceive) => {
            let finished = false
            while (!finished) {
              if (context.verb === `create` || context.verb === `update`) {
                const res = await checkIfDeployed({
                  selector: context.node.selector,
                  pagePath: context.node.pagePath,
                  value: context.node.value,
                  rootUrl: context.rootUrl,
                })
                if (
                  res.statusCode !== 200 ||
                  res.value?.toString() !== context.node.value.toString()
                ) {
                  callback({
                    type: `FAILED_CHECK`,
                    res: { ...res, timestamp: Date.now() },
                  })
                  await setTimeout(100)
                } else {
                  finished = true
                  callback({ type: `SUCCESS`, res })
                }
              } else if (context.verb === `delete`) {
                const res = await checkIf404({
                  pagePath: context.node.pagePath,
                  rootUrl: context.rootUrl,
                })
                if (res.statusCode !== 404) {
                  callback({
                    type: `FAILED_CHECK`,
                    res: { ...res, timestamp: Date.now() },
                  })
                  await setTimeout(100)
                } else {
                  finished = true
                  callback({ type: `SUCCESS`, res })
                }
              }
            }
          },
        },
        on: {
          FAILED_CHECK: {
            actions: assign({
              checks: (context, event) => [...context.checks, event.res],
              checkCount: (context) => (context.checkCount += 1),
            }),
          },
          SUCCESS: {
            target: `completed`,
            actions: [
              assign({
                completedAt: Date.now(),
                latency: (context) => Date.now() - context.createdAt,
              }),
              sendParent((context) => {
                const action = {
                  type: `NODE_UPDATED`,
                  node: {
                    ...context.node,
                    inFlight: false,
                    existsOnCMS: context.verb == `create` ? true : false,
                    published: context.verb == `create` ? true : false,
                  },
                }
                return action
              }),
            ],
          },
        },
      },

      completed: {
        type: `final`,
      },
      failure: {
        type: `final`,
      },
    },
  })
}

// invoke service to create file and return to operation and it returns it to engine
// operation machine invokes check callback service which responds with events of failed and success checks
// make operationsLimit work — scale up half the number of nodes and then start deleting them.
//
// TODO still
// log everything w/ Pino & child loggers
// then refactor all this code to the engine proper & rework the markdown example with the engine.

const nodeMachine = createMachine({
  id: `node`,
  initial: `creating`,
  context: {
    retries: 0,
  },
  states: {
    creating: {
      on: {
        FOUND: `completed`,
        FAILURE: `failure`,
      },
    },
    completed: {
      type: `final`,
    },
    failure: {
      type: `final`,
    },
  },
})

exports.run = (config, cb) => {
  const engineService = interpret(createEngineMachine(config)).onTransition(
    (state) => {
      cb(state)
    }
  )

  // Start the service
  engineService.start()
}

exports.createEngineMachine = createEngineMachine
