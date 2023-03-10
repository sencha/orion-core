'use strict';

// const Tunnel = require('tunnel');

const Base = require('orion-core/lib/Base');
const Configuration = require('orion-core/lib/config/Configuration');
const File = require('orion-core/lib/fs/File');
const Json = require('orion-core/lib/Json');
const Observable = require('orion-core/lib/Observable');
const xfs = require('orion-core/lib/xfs');

const License = require('orion-core/lib/license/License');
const License0 = require('orion-core/lib/license/License0');

const NO_BUENO = 'License server request failed';

/**
 * @class core.license.Manager
 * @extend core.Base
 */
class Manager extends Base {
    static get meta() {
        return {
            mixins: [
                Observable
            ],

            prototype: {
                licenseDir: xfs.profileDir,
                licenseFile: 'license.json',

                licenseServer: {
                    //path: '/api/license/index.php',
                    path: '/v1.0/license/trial/',
                    url: 'api.sencha.com'
                },

                proxySettings: null,

                products: [
                    // { code: 'test', version: 1 }
                ],

                schemas: [
                    License0,
                    License
                ],

                timeBomb: null
            }
        };
    }

    ctor() {
        var me = this,
            products = me.products,
            versionInfo = me.versionInfo,
            buildDate, entry, expires, i, name, shortName, version;

        me._licenses = [];

        if (!versionInfo.isConfiguration) {
            name = versionInfo.$isFile ? versionInfo.path : versionInfo;

            me.versionInfo = versionInfo = new Configuration();
            versionInfo.loadSync(name);
        }

        me.appName = me.appName || versionInfo.get('app.name');
        me.appShortName = me.appShortName || versionInfo.get('app.shortName');
        me.appVer = me.appVer || versionInfo.get('app.version');
        me.appMajorVer = me.appMajorVer || parseInt(me.appVer, 10);

        expires = versionInfo.get('app.expires');

        // When loading licenses from a file, we will disable timeBomb
        if (expires && me.timeBomb !== false) {
            if (isNaN(+expires)) {
                expires = new Date(expires);
            } else {
                // Handle app.expired=45
                // We need app.build.date=2016-02-03T00:00:00
                expires = +expires;

                buildDate = versionInfo.get('app.build.date');
                buildDate = new Date(buildDate);
                buildDate.setTime(buildDate.getTime() + expires * 24 * 60 * 60 * 1000);

                expires = buildDate;
            }

            me.timeBomb = expires;
            expires.setTime(60 * 1000 * expires.getTimezoneOffset() + expires.getTime());
        }

        if (!me.licensePath) {
            me.licensePath = me.licenseDir.join(me.appShortName).join(me.appMajorVer + '').
                join(me.licenseFile).path;
        }

        // Apply default name and version info to products.
        //
        for (i = products.length; i-- > 0;) {
            entry = products[i];

            name = entry.name || me.appName;
            version = entry.version || me.appVer;

            products[i] = Object.assign({
                name: name,
                version: parseInt(version, 10),
                fullVersion: version,

                // Create a shortName (e.g., "Test" from "Sencha Test"):
                short: name.startsWith('Sencha ') ? name.substring(7) : name
            }, entry);
        }

        me.load();
    }

    get count() {
        return this._licenses.length;
    }

    /**
     * @property {Boolean} expired
     * This value is `true` if the timeBomb has expired, `false` if not.
     * @readonly
     */
    get expired() {
        var timeBomb = this.timeBomb,
            now = Date.now();

        return timeBomb ? (now > +timeBomb) : false;
    }

    /**
     * @property {core.license.License[]} licenses
     * The array of licenses. Each access to this property returns a new array.
     * @readonly
     */
    get licenses() {
        return this._licenses.slice();
    }

    /**
     * @property {core.license.License[]} installedLicenses
     * The array of installed licenses. Each access to this property returns a new array.
     * @readonly
     */
    get installedLicenses() {
        return this._licenses.filter(lic => lic.signature || this.timeBomb);
    }

    log(message, extra) {
        // Hookable on instance level... for testing
        if (extra !== undefined) {
            console.log(message, extra);
        } else {
            console.log(message);
        }
    }

    /**
     * Given a `License` instance of (more likely) the data for a license, create (if
     * necessary) a proper `License` instance, add it to this `Manager` and return it.
     * 
     * For example:
     * 
     *      var license = manager.add({
     *          email: 'foo@bar.com',
     *          product: 'test'  // the product code is required
     *      });
     *      
     * Creates and attaches a new License instance to this Manager. Once a license is
     * attached, it can be activated via its `activate()` method.
     *
     * @param {Object/core.license.License} licenseData
     * @param {Boolean} [save=true] Pass `false` to avoid `save()`.
     * @return {core.license.License} Returns the `License` instance of `null` if the
     * license is associated with
     */
    add(licenseData, save) {
        var me = this,
            ret = licenseData,
            product;

        if (!licenseData.isLicense) {
            if (!(product = me.getProduct(licenseData))) {
                return null;
            }

            ret = Object.assign({}, licenseData);
            ret.product = product;

            // Make sure we can understand this license schema. Don't forget we may
            // be an old version opening a license file created by a newer install. So
            // just skip what we don't understand.
            //
            let T = me.recognize(ret);
            if (!T) {
                me.log('Ignoring unrecognized license', licenseData);
                return null;
            }

            ret = new T(ret);
        }

        if (me.get(ret.id)) {
            throw new Error('Cannot add license (duplicate id - ' + ret.id + ')');
        }

        ret.manager = me;
        me._licenses.push(ret);

        if (save !== false) {
            me.save();
        }

        /**
         * @event add
         * @param {Object} info
         * @param {core.license.Manager} sender
         * @param {Object} license The added license.
         */
        me.fire('add', {
            license: ret,
            save: save
        });

        return ret;
    }

    each(fn, scope) {
        var all = this.licenses, // copies but that makes loop safe
            i = 0,
            lic;

        for (lic of all) {
            if (false === fn.call(scope, lic, i++)) {
                break;
            }
        }
    }

    /**
     * Return a `License` instance given its id.
     * @param {String} id
     * @return {core.license.License}
     */
    get(id) {
        return this._licenses.find(lic => lic.id === id) || null;
    }

    /**
     * Returns a copy of the product definition object given its `code`.
     * @param {String/Object} code The product code or an object with the product code
     * as a property named `code` or an object with a "product" property.
     * @return {Object}
     */
    getProduct(code) {
        var ret = null,
            extra, s;

        if (code) {
            // If the object has a "product" property, it will be an object like this:
            //
            //      {
            //          code: 'test',
            //          activationCode: 'xxx',
            //          name: 'Sencha Test',
            //          version: 1
            //      }
            //
            // The old license format used capitalized names, so if "Product" is present
            // it will be something like "Sencha Test 1.x License" (give or take "Trial").
            //
            s = code.product || code.Product;
            if (s) {
                code = s;
            }

            if (typeof code === 'string') {
                if (code.startsWith('Sencha Test 1.x ')) { // Handle old license data
                    code = 'test';
                }
            } else {
                extra = code;
                code = code.code;
            }

            ret = this.products.find(prod => prod.code === code) || null;

            if (ret) {
                ret = Object.assign({}, ret, extra);
            } else {
                this.log('Unrecognized product code "' + code + '"');
            }
        }

        return ret;
    }

    getProductLicenses(code) {
        var prod = this.getProduct(code);

        if (!prod) {
            return [];
        }

        return this._licenses.filter(
            lic => lic.product.code === prod.code && lic.product.version === prod.version
        );
    }

    /**
     * @property {Object}
     *
     * example:
     * {
     *   host: 'localhost',
     *   port: 8080,
     *   proxyAuth: 'test:test' (username:password)
     * }
     */
    setProxySettings(proxySettings) {
        this.proxySettings = proxySettings;
    }

    /**
     * Loads the licenses from disk and adds them to this instance.
     */
    load() {
        var me = this,
            timeBomb = me.timeBomb,
            data = me.read();

        if (timeBomb) {
            // In a time-bombed build, all non-internal licenses are enabled
            // automatically. The internal license can be read from the license file.
            //
            timeBomb = timeBomb.toISOString();

            // Create faux licenses for each product (except the "internal" product).
            //
            me.products.forEach(function (product) {
                if (me.development || product.code !== 'internal') {
                    me.add(new License({
                        email: 'tester@beta.sencha.com',
                        expiration: timeBomb,
                        product: me.getProduct(product)
                    }), false); // save=false
                }
            });

            if (!me.development) {
                data.forEach(entry => {
                    if (entry.product && entry.product.code === 'internal') {
                        me.add(entry, false);  // save=false
                    }
                });
            }
        } else {
            data.forEach(entry => me.add(entry, false));
        }
    }

    onActivate(license) {
        this.save();

        /**
         * @event activate
         * @param {Object} info
         * @param {core.license.Manager} sender
         * @param {Object} license The new license.
         */
        this.fire('activate', {
            license: license
        });
    }

    /**
     * Reads and returns the license data array from the license file.
     * @return {Object[]}
     */
    read() {
        var me = this,
            file = new File(me.licensePath),
            data;

        if (file.existsSync()) {
            data = file.readSync();
            data = JSON.parse(data);

            if (Array.isArray(data)) {
                return data;
            }
            if (data.License && data.License.Signature) {
                return [data.License];
            }
            if (data.email ? data.signature : data.Signature) {
                // If we have valid-looking license object alone, pretend it is an
                // array. This allows us to load a single-license file (typically
                // sent as an attachment for off-line activation).
                return [data];
            }

            me.log('License file must be an array of license objects');
        } else {
            me.log('License file not found (' + me.licensePath + ')');
        }

        return [];
    }

    recognize(data) {
        return this.schemas.find(schema => schema.grok(data));
    }

    /**
     * Removes a `License` given an instance of id.
     * @param {String/core.license.License} id
     * @param {Boolean} [save=true] Pass `false` to avoid `save()`.
     * @return {core.license.License} The removed license or `null` if no match.
     */
    remove(id, save) {
        var me = this,
            licenses = me._licenses,
            ret = null,
            i, license;

        if (id) {
            license = id.isLicense ? id : me.get(id);

            if (license) {
                i = licenses.indexOf(license);

                if (i < licenses.length) {
                    licenses.splice(i, 1);

                    if (save !== false) {
                        me.save();
                    }

                    /**
                     * @event remove
                     * @param {Object} info
                     * @param {core.license.Manager} sender
                     * @param {Object} license The removed license.
                     */
                    me.fire('remove', {
                        license: ret = license,
                        save: save
                    });
                }
            }
        }

        return ret;
    }

    /**
     * Writes the activated licenses to disk.
     * @return {Manager} this
     */
    save() {
        var me = this,
            data, file, keep;

        data = me.serialize();
        keep = me.read();

        // The file may contain licenses we normally ignore (from a newer version
        // perhaps, which may even introduce unrecognized products), so gather up
        // the licenses that we don't recognize and append them. If we recognize
        // the entry we have to assume that it is present in our array or was
        // removed on purpose.
        if (me.timeBomb) {
            // We only read "internal" product licenses in this mode, so keep anything
            // that is not an internal product.
            keep = keep.filter(it => !(it.product && it.product.code === 'internal'));
        } else {
            keep = keep.filter(it => !me.recognize(it) || !me.getProduct(it));
        }

        data.push.apply(data, keep);

        data = JSON.stringify(data, null, 4);

        file = new File(me.licensePath);
        file.writeSync(data);

        return this;
    }

    /**
     * Serialize all properly installed `License` instances into an array.
     * @returns {core.license.License[]}
     */
    serialize() {
        var data = this._licenses.filter(lic => lic.signature);

        data = data.map(lic => lic.serialize());

        return data;
    }

    verify() {
        var all = [],
            result = [];

        this.installedLicenses.forEach((lic, i) => {
            all.push(lic.verify().then(r => result[i] = lic));
        });

        return Promise.all(all).then(r => result);
    }

    /**
     * Sends a POST request to the `licenseServer` and returns a Promise that will either
     * resolve to a result object (if successful) or an `Error` object with these
     * additional properties:
     *
     *  - **errorCode** - A string that describes the nature of the problem. It will be
     *  one of these values below. The values that use "-" are produced by the client
     *  while those using "_" are produced by the server.
     *    - bad-response                Server did not respond with a JSON object
     *    - http-failure                HTTP response was not 200 OK (see `statusCode`)
     *    - network-failure             Communication failure occurred (no HTTP response)
     *    - activation_code_required
     *    - activation_code_not_found   Activation code and email do not match
     *    - email_send_failure          Could not send email
     *    - email_validation            User is required to validate their email
     *    - email_validation_failure    Validation token is invalid
     *    - invalid_license             The license from SalesForce is invalid
     *    - invalid_license_product     The license does not match the product code
     *    - invalid_params              The request does not contain the proper params
     *    - license_create_failure      SalesForce did not return a license
     *    - no_salesforce_connection
     *    - product_not_found           The product code was not found in the database
     *    - product_required
     *    - unknown_error               A general error, likely a SQL failed
     *  - **response** - The HTTP response if one was received. This will be an Object if
     *  the response was JSON, otherwise it will be a String. This will not be present
     *  for `errorCode` of "network-failure".
     *  - **statusCode** - This property is present when `errorCode` is "http-failure".
     *
     * The protocol accepts a JSON object in the POST body that looks like this:
     *
     *      // @cfg {String} email (required)
     *      // The user's email address. Go figure...
     *      //
     *      email: '',
     *
     *      // @cfg {String/String[]} print (required)
     *      // An array of mac addresses. This can be an array, a comma-delimited or
     *      // a pipe-delimited string. Each string can use dashes (like from Windows)
     *      // or colons (everyone else) or can already be a sha1 hash of the colon
     *      // version. The license server replaces dashes with colons to normalize
     *      // the two.
     *      //
     *      // Acceptable formats:
     *      //
     *      //     ['mac1']
     *      //     ['mac1', 'mac2']
     *      //     'mac1'
     *      //     'mac1,mac2'
     *      //     'sha1-mac1|sha1-mac2'   // this is what we do
     *      //
     *      print: [
     *          '1a-22-bb-c3-dd-44', //can use dashes
     *          '22:1a:c3:bb:44:dd'  //can use colons
     *      ],
     *
     *      // @cfg {String} activationCode
     *      // A 40 digit activation code used to activate a license.
     *      //
     *      // Only required to activate a license, not start a trial.
     *      //
     *      activationCode: null,
     *
     *      // @cfg {Object} product (required)
     *      // The product descriptor to validate the activationCode
     *      // or start a trial with. Each object can have these params:
     *      //  - `code` required, the product code
     *      //  - `version` required, the product version likely just the major version
     *      //
     *      product : {
     *          code: 'sts',
     *          version: 1
     *      },
     *
     *      // @cfg {String} validation
     *      // An 8 digit email validation code. This is used when the license server
     *      // determines the user needs to validate their email address. The license
     *      // server will send them an email that contains an 8 digit code they can
     *      // enter into the Sencha product or can click a link and then try in the
     *      // Sencha product to start a trial or activate a license.
     *      //
     *      // When a user is required to validate their email address, the license
     *      // server will send this JSON response to signify to the Sencha product
     *      // this is happening. Please see the responses for an example response.
     *      //
     *      // Only required when email validation is required.
     *      //
     *      validation: null
     *
     * ## Responses
     *
     * ### Error with error code (200 OK):
     *
     *      success: false,
     *      error: "email_validation", // see errorCode list above
     *      msg: "Email validation required"
     *
     * ### Success
     *
     *      success: true,
     *      license: {
     *          email:      "foo@bar.com",
     *          expiration: "2016-01-01T12:30:00.000Z",
     *          id:         "8cb38ea8-9187-4c2a-90a8-6aec7b451f3d",
     *          isExpired:  false, //can be true or false
     *          isTrial:    true, //can be true or false
     *          print:      "MVo3s3uoxDscOOIXQoFHu1gswzo=|YvXKBdsqoSBE7AwDC2jGF8r4nQo=",
     *          type:       "Trial", //can be Trial or Paid
     *          version:    1,
     *          signature:  "nJli1PG6TU5bj...",
     *          product: {
     *              code: "sts",
     *              version: 1,
     *              activationCode: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
     *              name: "Sencha Test"
     *          }
     *      }
     *
     * @param {Object} params The parameters to send in the requests to the license server.
     * @return {Promise}
     */
    request(params) {
        const me = this;

        return new Promise(function (resolve, reject) {
            var server = me.licenseServer,
                postBody = JSON.stringify(params),
                request;

            // TODO, add this to orion-core/package.json in dependencies
            //   "tunnel": "^0.0.4",

            // var tunnelingAgent = Tunnel.httpsOverHttp({
            //     proxy: me.proxySettings
            // });

            var requestor = me.requestor || require('https').request;

            // request = Https.request({
            var requestorConfig = {
                method: 'POST',
                hostname: server.url,
                path: server.path + (params.activationCode ? 'activate' : 'start'),
                headers: {
                    'Content-Length': postBody.length,
                    'Content-Type': 'application/json'
                }
                // ,
                //     agent: tunnelingAgent
            }
            request = requestor(requestorConfig,
                function (res) {
                    let body = '';

                    res.setEncoding('utf-8');

                    res.on('data', function (chunk) {
                        body += chunk;
                    });

                    res.on('end', function () {
                        me.log('Response received from license server. ' + res.statusCode);
                        me.log(body);

                        if (res.statusCode === 200) {
                            try {
                                body = Json.parse(body);

                                if (body.success) {
                                    
                                    if (Array.isArray(body.license)) {
                                        body.license = body.license.filter(b => b.product.code == postBody.product.code)
                                    }

                                    resolve(body);
                                } else {
                                    let err = new Error(NO_BUENO + ': ' +
                                        body.msg);

                                    err.response = body;
                                    err.errorCode = body.error || body.code;

                                    reject(err);
                                }
                            } catch (e) {
                                // content must be JSON
                                e.message = NO_BUENO + ': ' + e.message;
                                e.response = body;
                                e.errorCode = 'bad-response';

                                reject(e);
                            }
                        } else {
                            let err = new Error(NO_BUENO + ': error ' + res.statusCode);

                            err.errorCode = 'http-failure';
                            err.statusCode = res.statusCode;

                            try {
                                err.response = Json.parse(body);
                            } catch (e) {
                                // ignore, content must not be JSON
                                err.response = body;
                            }

                            reject(err);
                        }
                    });
                }
            );

            request.on('error', function (e) {
                var err = (e instanceof Error) ? e : new Error(e); // must be a string

                err.message = NO_BUENO + ': ' + err.message;
                err.errorCode = 'network-failure';

                reject(err);
            });

            // me.log('Sending request for license...');
            // me.log('====== Req config ==========');
            // me.log(requestorConfig);
            // me.log('====== Req body ==========');
            // me.log(postBody);

            request.write(postBody);
            request.end();
        });
    }
}

module.exports = Manager;
