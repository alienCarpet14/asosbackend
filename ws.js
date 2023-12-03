#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const Y = require('yjs');
const syncProtocol = require('y-protocols/dist/sync.cjs');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const encoding = require('lib0/dist/encoding.cjs');
const decoding = require('lib0/dist/decoding.cjs');
const map = require('lib0/dist/map.cjs');
const debounce = require('lodash.debounce');
const callbackHandler = require('./callback.js').callbackHandler;
const isCallbackSet = require('./callback.js').isCallbackSet;
const config = require('./config');

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT) || 2000;
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT) || 10000;

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2;
const wsReadyStateClosed = 3;

const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0';
const persistenceDir = "./persistence/"//process.env.YPERSISTENCE;

let persistence = null;
if (typeof persistenceDir === 'string') {
    console.info('Persisting documents to "' + persistenceDir + '"');
    const LeveldbPersistence = require('y-leveldb').LeveldbPersistence;
    const ldb = new LeveldbPersistence(persistenceDir);
    persistence = {
        provider: ldb,
        bindState: async (docName, ydoc) => {
            const persistedYdoc = await ldb.getYDoc(docName);
            const newUpdates = Y.encodeStateAsUpdate(ydoc);
            ldb.storeUpdate(docName, newUpdates);
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
            ydoc.on('update', update => {
                ldb.storeUpdate(docName, update);
            });
        },
        writeState: async (docName, ydoc) => {}
    };
}

exports.setPersistence = persistence_ => {
    persistence = persistence_;
};

exports.getPersistence = () => persistence;

const docs = new Map();
exports.docs = docs;

const messageSync = 0;
const messageAwareness = 1;

const updateHandler = (update, origin, doc) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    doc.conns.forEach((_, conn) => send(doc, conn, message));

    console.log(`Document Content: ${Y.encodeStateAsUpdate(doc)}`);

    if (persistence !== null) {
        persistence.writeState(doc.name, doc).catch(error => {
            console.error('Error saving document state:', error);
        });
    }
};

class WSSharedDoc extends Y.Doc {
    constructor(name) {
        super({ gc: gcEnabled });
        this.name = name;
        this.conns = new Map();
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);

        const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
            const changedClients = added.concat(updated, removed);
            if (conn !== null) {
                const connControlledIDs = this.conns.get(conn);
                if (connControlledIDs !== undefined) {
                    added.forEach(clientID => { connControlledIDs.add(clientID); });
                    removed.forEach(clientID => { connControlledIDs.delete(clientID); });
                }
            }
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
            const buff = encoding.toUint8Array(encoder);
            this.conns.forEach((_, c) => {
                send(this, c, buff);
            });
        };

        this.awareness.on('update', awarenessChangeHandler);
        this.on('update', updateHandler);

        if (isCallbackSet) {
            this.on('update', debounce(
                callbackHandler,
                CALLBACK_DEBOUNCE_WAIT,
                { maxWait: CALLBACK_DEBOUNCE_MAXWAIT }
            ));
        }
    }
}

const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname);
    doc.gc = gc;
    if (persistence !== null) {
        persistence.bindState(docname, doc);
    }
    docs.set(docname, doc);
    return doc;
});

exports.getYDoc = getYDoc;

const messageListener = (conn, doc, message) => {
    try {
        const encoder = encoding.createEncoder();
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
            case messageSync:
                encoding.writeVarUint(encoder, messageSync);
                syncProtocol.readSyncMessage(decoder, encoder, doc, conn);

                if (encoding.length(encoder) > 1) {
                    send(doc, conn, encoding.toUint8Array(encoder));
                }
                break;
            case messageAwareness:
                awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
                break;
        }
    } catch (err) {
        console.error(err);
        doc.emit('error', [err]);
    }
};

const closeConn = (doc, conn) => {
    if (doc.conns.has(conn)) {
        const controlledIds = doc.conns.get(conn);
        doc.conns.delete(conn);
        awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);
        if (doc.conns.size === 0 && persistence !== null) {
            persistence.writeState(doc.name, doc).then(() => {
                doc.destroy();
            });
            docs.delete(doc.name);
        }
    }
    conn.close();
};

const send = (doc, conn, m) => {
    if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
        closeConn(doc, conn);
    }
    try {
        conn.send(m, err => { err != null && closeConn(doc, conn); });
    } catch (e) {
        closeConn(doc, conn);
    }
};

const pingTimeout = 30000;

exports.setupWSConnection = (conn, req, { docName = req.url.slice(1).split('?')[0], gc = true } = {}) => {
    conn.binaryType = 'arraybuffer';
    const doc = getYDoc(docName, gc);
    doc.conns.set(conn, new Set());

    conn.on('message', message => messageListener(conn, doc, new Uint8Array(message)));

    let pongReceived = true;
    const pingInterval = setInterval(() => {
        if (!pongReceived) {
            if (doc.conns.has(conn)) {
                closeConn(doc, conn);
            }
            clearInterval(pingInterval);
        } else if (doc.conns.has(conn)) {
            pongReceived = false;
            try {
                conn.ping();
            } catch (e) {
                closeConn(doc, conn);
                clearInterval(pingInterval);
            }
        }
    }, pingTimeout);

    conn.on('close', () => {
        closeConn(doc, conn);
        clearInterval(pingInterval);
    });

    conn.on('pong', () => {
        pongReceived = true;
    });

    {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeSyncStep1(encoder, doc);
        send(doc, conn, encoding.toUint8Array(encoder));

        const awarenessStates = doc.awareness.getStates();
        if (awarenessStates.size > 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
            send(doc, conn, encoding.toUint8Array(encoder));
        }
    }
};

const host = process.env.HOST ||  config.server.host;
const port = process.env.PORT || config.server.port;

const server = http.createServer((request, response) => {
    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.end('okay');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', exports.setupWSConnection);

server.on('upgrade', (request, socket, head) => {
    const handleAuth = ws => {
        wss.emit('connection', ws, request);
    };

    wss.handleUpgrade(request, socket, head, ws => {
        ws.on('error', error => {
            console.error('WebSocket error:', error);
            ws.destroy();
        });

        handleAuth(ws);
    });
});

// used for console.log of document content
const loadDocumentFromDisk = async () => {
    console.log('Loading documents from disk...');
    // if (persistence !== null) {
    //     const docNames = ['asos-room/1','asos-room/2','asos-room/3'];
    //     console.log(`docNames= ${docNames}`);
    //     for (const docName of docNames) {
    //         const doc = getYDoc(docName, true);
    //         console.log(`Loaded document: ${docName}`);
    //         console.log(`Loaded document with content: ${Y.encodeStateAsUpdate(doc)}`)
    //         await persistence.bindState(docName, doc).catch(error => {
    //             console.error('Error loading document state:', error);
    //         });
    //     }
    // }
};
// const loadDocumentFromDisk= async () => {}

loadDocumentFromDisk().then(() => {
    server.listen(port, host, () => {
        console.log(`Server running at '${host}' on port ${port}`);
    });
});
