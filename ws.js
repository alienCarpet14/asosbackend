const Y = require('yjs')
const syncProtocol = require('y-protocols/dist/sync.cjs')
const awarenessProtocol = require('y-protocols/dist/awareness.cjs')

const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')
const map = require('lib0/dist/map.cjs')

const debounce = require('lodash.debounce')

const callbackHandler = require('./callback.js').callbackHandler
const isCallbackSet = require('./callback.js').isCallbackSet

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT) || 2000
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT) || 10000

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'
const persistenceDir = process.env.YPERSISTENCE
/**
 * @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null}
 */
let persistence = null
if (typeof persistenceDir === 'string') {
    console.info('Persisting documents to "' + persistenceDir + '"')
    // @ts-ignore
    const LeveldbPersistence = require('y-leveldb').LeveldbPersistence
    const ldb = new LeveldbPersistence(persistenceDir)
    persistence = {
        provider: ldb,
        bindState: async (docName, ydoc) => {
            const persistedYdoc = await ldb.getYDoc(docName)
            const newUpdates = Y.encodeStateAsUpdate(ydoc)
            ldb.storeUpdate(docName, newUpdates)
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
            ydoc.on('update', update => {
                ldb.storeUpdate(docName, update)
            })
        },
        writeState: async (docName, ydoc) => {}
    }
}

/**
 * @param {{bindState: function(string,WSSharedDoc):void,
 * writeState:function(string,WSSharedDoc):Promise<any>,provider:any}|null} persistence_
 */
exports.setPersistence = persistence_ => {
    persistence = persistence_
}

/**
 * @return {null|{bindState: function(string,WSSharedDoc):void,
 * writeState:function(string,WSSharedDoc):Promise<any>}|null} used persistence layer
 */
exports.getPersistence = () => persistence

/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map()
// exporting docs so that others can use it
exports.docs = docs

const messageSync = 0
const messageAwareness = 1
// const messageAuth = 2

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    const message = encoding.toUint8Array(encoder)
    doc.conns.forEach((_, conn) => send(doc, conn, message))
}

class WSSharedDoc extends Y.Doc {
    /**
     * @param {string} name
     */
    constructor (name) {
        super({ gc: gcEnabled })
        this.name = name
        /**
         * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
         * @type {Map<Object, Set<number>>}
         */
        this.conns = new Map()
        /**
         * @type {awarenessProtocol.Awareness}
         */
        this.awareness = new awarenessProtocol.Awareness(this)
        this.awareness.setLocalState(null)
        /**
         * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
         * @param {Object | null} conn Origin is the connection that made the change
         */
        const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
            const changedClients = added.concat(updated, removed)
            if (conn !== null) {
                const connControlledIDs = /** @type {Set<number>} */ (this.conns.get(conn))
                if (connControlledIDs !== undefined) {
                    added.forEach(clientID => { connControlledIDs.add(clientID) })
                    removed.forEach(clientID => { connControlledIDs.delete(clientID) })
                }
            }
            // broadcast awareness update
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, messageAwareness)
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
            const buff = encoding.toUint8Array(encoder)
            this.conns.forEach((_, c) => {
                send(this, c, buff)
            })
        }
        this.awareness.on('update', awarenessChangeHandler)
        this.on('update', updateHandler)
        if (isCallbackSet) {
            this.on('update', debounce(
                callbackHandler,
                CALLBACK_DEBOUNCE_WAIT,
                { maxWait: CALLBACK_DEBOUNCE_MAXWAIT }
            ))
        }
    }
}

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname)
    doc.gc = gc
    if (persistence !== null) {
        persistence.bindState(docname, doc)
    }
    docs.set(docname, doc)
    return doc
})

exports.getYDoc = getYDoc

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
    try {
        const encoder = encoding.createEncoder()
        const decoder = decoding.createDecoder(message)
        const messageType = decoding.readVarUint(decoder)
        switch (messageType) {
            case messageSync:
                encoding.writeVarUint(encoder, messageSync)
                syncProtocol.readSyncMessage(decoder, encoder, doc, conn)

                // If the `encoder` only contains the type of reply message and no
                // message, there is no need to send the message. When `encoder` only
                // contains the type of reply, its length is 1.
                if (encoding.length(encoder) > 1) {
                    send(doc, conn, encoding.toUint8Array(encoder))
                }
                break
            case messageAwareness: {
                awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
                break
            }
        }
    } catch (err) {
        console.error(err)
        doc.emit('error', [err])
    }
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
    if (doc.conns.has(conn)) {
        /**
         * @type {Set<number>}
         */
            // @ts-ignore
        const controlledIds = doc.conns.get(conn)
        doc.conns.delete(conn)
        awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
        if (doc.conns.size === 0 && persistence !== null) {
            // if persisted, we store state and destroy ydocument
            persistence.writeState(doc.name, doc).then(() => {
                doc.destroy()
            })
            docs.delete(doc.name)
        }
    }
    conn.close()
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
    if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
        closeConn(doc, conn)
    }
    try {
        conn.send(m, /** @param {any} err */ err => { err != null && closeConn(doc, conn) })
    } catch (e) {
        closeConn(doc, conn)
    }
}

const pingTimeout = 30000

/**
 * @param {any} conn
 * @param {any} req
 * @param {any} opts
 */
exports.setupWSConnection = (conn, req, { docName = req.url.slice(1).split('?')[0], gc = true } = {}) => {
    conn.binaryType = 'arraybuffer'
    // get doc, initialize if it does not exist yet
    const doc = getYDoc(docName, gc)
    doc.conns.set(conn, new Set())
    // listen and reply to events
    conn.on('message', /** @param {ArrayBuffer} message */ message => messageListener(conn, doc, new Uint8Array(message)))

    // Check if connection is still alive
    let pongReceived = true
    const pingInterval = setInterval(() => {
        if (!pongReceived) {
            if (doc.conns.has(conn)) {
                closeConn(doc, conn)
            }
            clearInterval(pingInterval)
        } else if (doc.conns.has(conn)) {
            pongReceived = false
            try {
                conn.ping()
            } catch (e) {
                closeConn(doc, conn)
                clearInterval(pingInterval)
            }
        }
    }, pingTimeout)
    conn.on('close', () => {
        closeConn(doc, conn)
        clearInterval(pingInterval)
    })
    conn.on('pong', () => {
        pongReceived = true
    })
    // put the following in a variables in a block so the interval handlers don't keep in in
    // scope
    {
        // send sync step 1
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeSyncStep1(encoder, doc)
        send(doc, conn, encoding.toUint8Array(encoder))
        const awarenessStates = doc.awareness.getStates()
        if (awarenessStates.size > 0) {
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, messageAwareness)
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())))
            send(doc, conn, encoding.toUint8Array(encoder))
        }
    }
}

/**
 * @type {any}
 */
const WebSocket = require('ws')
const http = require('http')
const wss = new WebSocket.Server({ noServer: true })
const setupWSConnection = require('./utils.js').setupWSConnection

const host = process.env.HOST || '0.0.0.0'
const port = process.env.PORT || 4444

const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('okay')
})

wss.on('connection', setupWSConnection)

server.on('upgrade', (request, socket, head) => {
    // You may check auth of request here..
    // See https://github.com/websockets/ws#client-authentication
    /**
     * @param {any} ws
     */
    const handleAuth = ws => {
        wss.emit('connection', ws, request)
    }
    wss.handleUpgrade(request, socket, head, ws => {
        ws.on('error', (error) => {
            // Handle the error event here
            console.error('WebSocket error:', error);

            // Use the destroy method to close the socket
            ws.destroy();
        });

        handleAuth(ws);
    });
})

server.listen(port, host, () => {
    console.log(`running at '${host}' on port ${port}`)
})