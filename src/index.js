/**
 * The type of messages our frames our sending
 * @type {String}
 */
const messageType = 'application/x-postmate-v1+json'

/**
 * The maximum number of attempts to send a handshake request to the parent
 * @type {Number}
 */
const handshakeRequestsCount = 5

/**
 * The amount of time between handshake sends
 * @type {Number}
 */
const handshakeCoolDown = 500

/**
 * The amount of time between handshake sends
 * @type {Number}
 */
const responseTimeout = 1500

/**
 * A unique ID that is used to ensure responses are sent to the correct requests
 * @type {Number}
 */
let id = 0

/**
 * Increments and returns an ID
 * @return {Number} A unique ID for a message
 */
const nextId = () => ++id

/**
 * A unique message ID that is used to ensure responses are sent to the correct requests
 * @type {Number}
 */
let requestId = 0

/**
 * Increments and returns a message ID
 * @return {Number} A unique ID for a message
 */
const nextRequestId = () => ++requestId

/**
 * Postmate logging function that enables/disables via config
 * @param args
 */
const log = (...args) => Postmate.debug && process.env.NODE_ENV !== 'production' ? console.log(...args) : null // eslint-disable-line no-console

/**
 * Takes a URL and returns the origin
 * @param  {String} url The full URL being requested
 * @return {String}     The URLs origin
 */
const resolveOrigin = (url) => {
    const a = document.createElement('a')
    a.href = url
    const protocol = a.protocol.length > 4 ? a.protocol : window.location.protocol
    const host = a.host.length ? ((a.port === '80' || a.port === '443') ? a.hostname : a.host) : window.location.host
    return a.origin || `${protocol}//${host}`
}

const proxy = async function (key, spec, ...args) {
    if (spec[key] > 0 && args.length < spec[key])
        throw Error(`Method ${key} expects there to be at least ${spec} arguments`)
    return await this.emit(key, args)
}

export class Actor {
    _getCapabilities() {
        let spec = {},
            proto = Object.getPrototypeOf(this)

        while (proto !== null) {
            let keys = Object.getOwnPropertyNames(proto)
            if (keys.includes('_getCapabilities'))
                proto = null
            else {
                spec = keys.reduce((spec, key) => {
                    switch (true) {
                        case key === 'constructor':
                        case key.substr(0, 1) === '_':
                        case key in spec:
                        case typeof this[key] !== 'function':
                            return spec
                    }

                    spec[key] = this[key].length
                    return spec
                }, spec)
                proto = Object.getPrototypeOf(proto)
            }
        }

        return spec
    }
}

class Config {
    frame
    actor

    constructor(config) {
        this.frame = config.frame
        this.actor = config.actor
    }
}

class API {
    id
    origin
    outbound
    inbound

    /**
     * @param {String} id
     * @param {String} origin
     * @param {Config} outbound
     * @param {Config} inbound
     */
    constructor(id, origin, outbound, inbound) {
        this.id = id
        this.origin = origin
        this.outbound = outbound
        this.inbound = inbound

        log('Registering API')
        for (let key of Object.keys(this.outbound.actor)) {
            this[key] = proxy.bind(this, key, this.outbound.actor)
        }

        log('Awaiting messages...')

        this.inbound.frame.addEventListener('message', ({data, origin}) => {

            log('Received request', data)

            let processable = !!data.postmate
                && data.type === messageType
                && origin === this.origin
                && data.id === this.id
                && data.postmate in this.inbound.actor

            if (processable) {
                Promise
                    .resolve(this.inbound.actor[data.postmate](...data.payload))
                    .then((val) => {
                        this.outbound.frame.postMessage({
                            postmate: '_response',
                            id: this.id,
                            requestId: data.requestId,
                            payload: [val],
                            type: messageType
                        }, this.origin)
                    })
            }
        })

        log('Awaiting event emissions from Child')
    }

    emit(name, args) {
        return new Promise((resolve, reject) => {
            log(`Emitting Event "${name}"`, args)
            let requestId = nextRequestId()

            let watchdog;
            let responseListener = (e) => {
                let processable = e.data.postmate === '_response'
                    && e.data.type === messageType
                    && e.origin === this.origin
                    && e.data.id === this.id
                    && e.data.requestId === requestId

                if (processable) {
                    clearTimeout(watchdog)
                    this.inbound.frame.removeEventListener('message', responseListener)
                    resolve(e.data.payload[0])
                }
            }

            watchdog = setTimeout(() => {
                this.inbound.frame.removeEventListener('message', responseListener)
                reject('Timed out before a response returned')
            }, responseTimeout)

            this.inbound.frame.addEventListener('message', responseListener)

            this.outbound.frame.postMessage({
                postmate: name,
                id: this.id,
                payload: args,
                requestId,
                type: messageType,
            }, this.origin)
        })
    }
}

/**
 * Composes an API to be used by the parent
 * @param {Object} info Information on the consumer
 */
class ParentAPI extends API {
    constructor(id, origin, outboundSpec, inboundActor) {
        super(
            id,
            origin,
            new Config({
                frame: window.opener || window.parent,
                actor: outboundSpec,
            }),
            new Config({
                frame: window,
                actor: inboundActor,
            }),
        );
    }
}

/**
 * Composes an API to be used by the child
 */
class ChildAPI extends API {
    constructor(id, origin, outboundFrame, outboundSpec, inboundActor) {
        super(
            id,
            origin,
            new Config({
                frame: outboundFrame,
                actor: outboundSpec,
            }),
            new Config({
                frame: window,
                actor: inboundActor,
            }),
        );
    }
}

class Channel {
    parent
    child
    actor
    promise

    /**
     * Sets options related to the Parent
     * @param {Actor} actor
     * @param {Object} parent
     * @param {Object} child
     * @return {Promise}
     */
    constructor(actor, parent, child) {
        this.parent = parent
        this.child = child
        this.actor = actor

        this.handleChildClosure()
        this.handleParentClosure()
    }

    async end() {
        await this.then(async (parent) => {
            await parent.emit('_close', ['closing'])
        })
    }

    then(handler) {
        return this.promise.then(handler)
    }

    catch(handler) {
        return this.promise.catch(handler)
    }

    finally(handler) {
        return this.promise.finally(handler)
    }

    handleChildClosure() {
        throw new Error('Method not implemented')
    }

    handleParentClosure() {
        throw new Error('Method not implemented')
    }
}

/**
 * The entry point of the Parent.
 * @type {Class}
 */
export class Child extends Channel {
    /**
     *
     * @param {String} url
     * @param {String} name
     * @param {Actor} actor
     * @param {string} options
     * @returns {Child}
     */
    static window(url, name, actor = null, options = null) {
        let frame = window.open(url, name, options)
        return new Child(actor, url, frame, frame)
    }

    /**
     * @param {String} url
     * @param {String} name
     * @param {Actor} actor
     * @param {Function} options
     * @param {HTMLElement} container
     * @returns {Child}
     */
    static iframe(url, name, actor = null, options = null, container = document.body) {
        let frame = document.createElement('iframe')
        if (options) options(frame)
        frame.name = name
        container.appendChild(frame)
        return new Child(actor, url, frame, frame.contentWindow || frame.contentDocument.parentWindow)
    }

    frame
    url

    /**
     * Sets options related to the Parent
     * @param {Actor} actor
     * @param {String} url
     * @param {Object} frame
     * @param {Object} child
     * @return {Promise}
     */
    constructor(actor, url, frame, child) {
        super(actor, window, child)
        this.frame = frame
        this.url = url
        this.promise = this.sendHandshake(url)
    }

    /**
     * Begins the handshake strategy
     * @return {Promise} Promise that resolves when the handshake is complete
     */
    sendHandshake() {
        return new Promise((resolve, reject) => {
            const childOrigin = resolveOrigin(this.url)
            let attempt = 0,
                responseInterval,
                id = nextId(),
                watchdog

            const reply = (e) => {
                if (e.data.postmate === '_handshake' && e.data.id === id && e.origin === childOrigin) {
                    clearTimeout(watchdog)
                    clearInterval(responseInterval)

                    log('Received handshake reply from Child')
                    this.parent.removeEventListener('message', reply, false)

                    return resolve(new ChildAPI(id, e.origin, this.child, e.data.payload[0], this.actor))
                }
            }

            watchdog = setTimeout(() => {
                this.child.removeEventListener('message', reply, false)

                log('Invalid handshake reply')
                reject('Handshake never received')
            }, handshakeCoolDown * handshakeRequestsCount)

            this.parent.addEventListener('message', reply, false)

            const doSend = () => {
                attempt++
                log(`Sending handshake attempt ${attempt}`, {childOrigin})

                try {
                    this.child.postMessage({
                        postmate: '_handshake',
                        id,
                        payload: [
                            this.actor._getCapabilities()
                        ],
                        type: messageType,
                    }, childOrigin)
                } finally {
                    if (attempt >= handshakeRequestsCount) {
                        clearInterval(responseInterval)
                    }
                }
            }

            const loaded = () => {
                responseInterval = setInterval(doSend, 500)
            }

            this.frame.addEventListener('load', loaded)

            log(`Loading frame ${this.url}`)
            if (!this.frame.src) {
                this.frame.src = this.url
            }
        })
    }

    async focus() {
        this.child.focus();
    }

    handleParentClosure() {
        this.parent.addEventListener('beforeunload', () => {
            this.child.close();
        })
    }

    handleChildClosure() {
        this.child.addEventListener('beforeunload', () => {
            let attempt = 0,
                checker = setTimeout(() => {
                    attempt++
                    if (this.child.document.readyState !== 'loading') {
                        clearTimeout(checker)
                        this.promise = this.sendHandshake().catch(false)
                        this.handleChildClosure()
                    } else if (attempt > handshakeRequestsCount) {
                        clearTimeout(checker)
                    }
                }, handshakeCoolDown)
        })
    }
}

/**
 * The entry point of the Child
 * @type {Class}
 */
export class Parent extends Channel {
    static listen(actor) {
        return new Parent(actor)
    }

    /**
     * Initializes the child, actor, parent, and responds to the Parents handshake
     * @param {Actor} actor Hash of values, functions, or promises
     * @return {Promise} The Promise that resolves when the handshake has been received
     */
    constructor(actor) {
        super(actor, window.parent || window.opener, window)
        this.promise = this.sendHandshakeReply()
    }

    /**
     * Responds to a handshake initiated by the Parent
     * @return {Promise} Resolves an object that exposes an API for the Child
     */
    sendHandshakeReply() {
        return new Promise((resolve, reject) => {
            let watchdog = setTimeout(() => {
                this.child.removeEventListener('message', shake, false)
                reject('Handshake never received')
            }, handshakeCoolDown * handshakeRequestsCount)
            let shake = (e) => {
                if (e.data.postmate === '_handshake') {
                    log('Received handshake from Parent')
                    clearTimeout(watchdog)
                    this.child.removeEventListener('message', shake, false)

                    log('Sending handshake reply to Parent')
                    e.source.postMessage({
                        postmate: '_handshake',
                        id: e.data.id,
                        payload: [
                            this.actor._getCapabilities()
                        ],
                        type: messageType,
                    }, e.origin)

                    log('Loaded spec from Parent')

                    return resolve(new ParentAPI(e.data.id, e.origin, e.data.payload[0], this.actor))
                }
            }
            this.child.addEventListener('message', shake, false)
        });
    }

    handleParentClosure() {
        this.parent.addEventListener('beforeunload', () => {
            this.child.close();
        })
    }

    handleChildClosure() {
    }

    async focus() {
        this.parent.focus();
    }
}