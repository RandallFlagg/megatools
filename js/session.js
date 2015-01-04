/**
 * Session
 *
 * This object represnets a state of a remote user account locally. It
 * stores important user data locally for use in various operations, so
 * that then don't need to be retrieved repetitively. 
 *
 * These include:
 *
 *   - master key
 *   - password key
 *   - RSA key pair
 *   - user's handle
 *   - user's real name
 *   - user's email
 *
 * It also stores session id generated by the mega server after login.
 *
 * Session object can be safely stored to disk (the storage is encrypted
 * and does not contain any identifiable information).
 *
 * How to use Session object
 * =========================
 *
 * var s = new Session();
 *
 * You need to set credentials first:
 *
 *   - user handle and password - for ephemeral account
 *   - user email and password - for full user account
 *
 * s.setCredentials('my@email.net', 'my-pw');
 * 
 * Then you can open session (which will try to resume session in the
 * most effective way, or login, therefore creating a new session, if 
 * resume fails):
 *
 * s.open()
 *   .done(function() {
 *     // do something
 *   })
 *   .fail(function(errorCode, errorMessage) {
 *     // error
 *   });
 *
 */

GW.define('Session', 'object', {

	timeout: 60 * 60, // 1 hour session timeout

	initObject: function() {
		this.api = new MegaAPI();
		this.data = {};
		this.fs = new Filesystem({
			session: this
		});
	},

	setCredentials: function(username, password) {
		this.username = username;
		this.password = password;
		this.pk = C.aes_key_from_password(password);
	},

	getSessionFilePath: function(name) {
		var digest = C.sha256_digest(Duktape.Buffer(this.username + this.password + (name || '')));
		var ed = C.ub64enc(C.aes_enc_cbc(this.pk, digest));

		return [C.get_tmp_dir(), ed.substr(0, 30)].join(C.os == 'windows' ? '\\' : '/');
	},

	loadSessionFile: function(name) {
		var path = this.getSessionFilePath(name);
		var data = C.file_read(path);
		if (!data) {
			return null;
		}

		var nonce = C.slicebuf(C.sha256_digest(Duktape.Buffer(this.username + this.password + (name || ''))), 0, 8);
		var plain = C.aes_ctr(this.pk, nonce, 0, data);
		var plain_digest = C.slicebuf(plain, 0, 32);
		var plain_payload = C.slicebuf(plain, 32);

		if (C.sha256_digest(plain_payload) != plain_digest) {
			return null;
		}

		Log.debug('Loaded session file', name || 'session');
		//Log.debug(plain_payload.toString());

		return plain_payload;
	},

	saveSessionFile: function(name, plain_payload) {
		var path = this.getSessionFilePath(name);
		var plain_digest = C.sha256_digest(plain_payload);
		var plain = C.joinbuf(plain_digest, plain_payload);
		var nonce = C.slicebuf(C.sha256_digest(Duktape.Buffer(this.username + this.password + (name || ''))), 0, 8);
		var data = C.aes_ctr(this.pk, nonce, 0, plain);

		Log.debug('Saved session file', name || 'session', 'at', path);

		return C.file_write(path, data);
	},

	removeSessionFile: function(name) {
		var path = this.getSessionFilePath(name);

		C.file_remove(path);
	},

	// load session from disk
	load: function() {
		var plain_payload = this.loadSessionFile();
		if (!plain_payload) {
			return false;
		}

		this.data = Duktape.dec('jx', plain_payload.toString());

		var fs_data = this.loadSessionFile('fs');
		if (fs_data) {
			this.fs.setData(fs_data);
		}

		return true;
	},

	// save session to disk
	save: function() {
		this.data.saved = (new Date).getTime();
		this.data.sid = this.api.sid;
		this.data.sidParamName = this.api.sidParamName;

		this.saveSessionFile('fs', this.fs.getData());

		return this.saveSessionFile(null, Duktape.Buffer(Duktape.enc('jx', this.data)));
	},

	// check if session is loaded and fresh (i.e. doesn't need getUser call to check the data)
	isFresh: function() {
		return this.data.saved && this.data.saved > (new Date).getTime() - this.timeout * 1000;
	},

	isEphemeral: function() {
		return this.username && String(this.username).match(/^[a-zA-Z0-9_-]{11}$/);
	},

	open: function(forceCheck) {
		var me = this;

		return Defer.defer(function(defer) {
			function getUser() {
				return me.api.getUser().done(function(res) {
					_.extend(me.data, res);

					me.data.uh = res.user.u;
					me.data.pubk = res.user.pubk;
					me.data.privk = res.user.privk;

					me.save();
				});
			}

			function login() {
				if (me.isEphemeral()) {
					return me.api.loginEphemeral(me.username, me.password).done(function(res) {
						me.data.mk = res.mk;
					});
				} else {
					return me.api.login(me.username, me.password).done(function(res) {
						me.data.mk = res.mk;
					});
				}
			}

			function loginAndGetUser() {
				login().then(function() {
					getUser().then(defer.resolve, defer.reject);
				}, defer.reject);
			}

			if (me.load()) {
				if (me.isFresh() && !forceCheck) {
					defer.resolve();
				} else {
					Log.debug('Re-using saved session id:', me.data.sidParamName || 'sid', '=', me.data.sid);

					me.api.setSessionId(me.data.sid, me.data.sidParamName);

					getUser().then(defer.resolve, function() {
						loginAndGetUser();
					});
				}
			} else {
				loginAndGetUser();
			}
		});
	},

	close: function() {
		this.removeSessionFile();
		this.removeSessionFile('fs');
	},

	openExportedFolder: function(n, mk) {
		this.data = {};
		this.data.mk = mk;
		this.data.isExportedFolder = true;

		this.api.setSessionId(n, 'n');
	},

	// needs optimized C written code for fs cache/path mapping

	getFilesystem: function() {
		return this.fs;
	},

	getUserHandle: function() {
		return this.data.uh;
	},

	getMasterKey: function() {
		return this.data.mk;
	}
});

var NodeType = {
	FILE: 0,
	FOLDER: 1,
	ROOT: 2,
	INBOX: 3,
	RUBBISH: 4,
	NETWORK: 9,
	CONTACT: 8,
	TOP: 9
};

GW.define('Filesystem', 'object', {

	initObject: function() {
		this.nodes = {};
		this.pathMap = {};
		this.children = {};
		this.share_keys = [];
	},

	getData: function() {
		return Duktape.Buffer(Duktape.enc('jx', {nodes: this.nodes, share_keys: this.share_keys}));
	},

	setData: function(data) {
		data = Duktape.dec('jx', data.toString());

		_.extend(this, data);
	},

	importNode: function(data) {
		var n = {};

		n.type = data.t;
		n.handle = data.h;
		n.parent_handle = data.p || '*TOP*';
		n.su_handle = data.su;
		n.user = data.u;
		n.size = data.s;
		n.mtime = data.ts;

		// laod key
		if (data.k) {
			//XXX: 46+ longer keys are RSA keys, handle them

			var matches = data.k.match(/[0-9a-z_-]{8,11}:[0-9a-z_-]{22,45}/ig);
			for (var key in matches) {
				var keyHandle = matches[key].split(':')[0];
				var keyData = C.ub64dec(matches[key].split(':')[1]);
				var decKey;

				if (this.session.getUserHandle() == keyHandle) {
					decKey = this.session.getMasterKey();
				} else {
					decKey = this.getShareKey(keyHandle);
				}

				if (decKey) {
					if (n.type == NodeType.FILE) { 
						n.key_full = C.aes_dec(decKey, keyData);
						n.key = C.file_node_key_unpack(n.key_full);
					} else {
						n.key = C.aes_dec(decKey, keyData);
					}
				} else {
					Log.warning('No key found for node', data);
					return null;
				}
			}
		}

		// decrypt attrs
		if (n.key && data.a) {
			var a = C.ub64dec(data.a);
			var attrs = C.aes_dec_cbc(n.key, a);

			if (attrs && C.slicebuf(attrs, 0, 5) == Duktape.Buffer('MEGA{')) {
				attrs = C.slicebuf(attrs, 4);
				n.attrs = JSON.parse(C.buftojsonstring(attrs));
				n.name = n.attrs.n;
			} else {
				Log.warning('Attribute decryption failed', data);
				return null;
			}


			if (C.os == 'windows') {
				if (n.name == '.' || n.name == '..' || n.name.match(/\/\\<>:"\|\?\*/)) {
					Log.warning('Node has invalid name', n.name, data);
					return null;
				}
			} else {
				if (n.name == '.' || n.name == '..' || n.name.match(/\//)) {
					Log.warning('Node has invalid name', n.name, data);
					return null;
				}
			}
		}

		if (n.type == NodeType.RUBBISH) {
			n.name = "Rubbish";
		} else if (n.type == NodeType.INBOX) {
			n.name = "Inbox";
		} else if (n.type == NodeType.ROOT) {
			n.name = "Root";
		}

		if (data.sk) {
			var esk = C.ub64dec(data.sk), sk;
			if (sk.length > 16) {
				sk = C.rsa_decrypt(this.session.data.privk, this.session.data.mk, sk);
			} else if (sk.length == 16) {
				sk = C.aes_dec(this.session.data.mk, sk);
			} else {
				Log.warning('Can\'t decrypt share key for', data);
			}

			if (sk) {
				this.setShareKey(n.handle, C.slicebuf(sk, 0, 16));
			}
		}

		return n;
	},

	load: function() {
		return this.session.api.callSingle({
			a: 'f',
			c: 1,
			r: 1
		}).done(function(r) {
			var i, l;

			this.nodes = {};
			this.nodes['*TOP*'] = {
				name: '',
				type: NodeType.TOP,
				handle: '*TOP*',
				size: 0,
				mtime: 0
			};

			if (r.ok) {
				for (i = 0, l = r.ok.length; i < l; i++) {
					var ok = r.ok[i];

					// ok.h = h.8                                   
					// ok.ha = b64(aes(h.8 h.8, master_key))        
					// ok.k = b64(aes(share_key_for_h, master_key)) 

					var h = Duktape.Buffer(ok.h);
					var ha = C.aes_dec(this.session.getMasterKey(), C.ub64dec(ok.ha));
					var k = C.aes_dec(this.session.getMasterKey(), C.ub64dec(ok.k));

					if (ha == C.joinbuf(h, h)) {
						this.setShareKey(h, k);
					} else {
						Log.warning('Share key can\'t be authenticated ', ok);
					}
				}
			}

			if (r.f) {
				if (this.session.data.isExportedFolder) {
					r.f[0].p = null;

					this.addShareKey(r.f[0].h, this.session.data.mk);
				}

				for (i = 0, l = r.f.length; i < l; i++) {
					var node = this.importNode(r.f[i]);
					if (node) {
						this.nodes[node.handle] = node;
					}
				}
			}

			this.nodes['*NETWORK'] = {
				name: 'Contacts',
				type: NodeType.NETWORK,
				parent_handle: '*TOP*',
				handle: '*NETWORK',
				size: 0,
				mtime: 0
			};

			if (r.u) {
				for (i = 0, l = r.u.length; i < l; i++) {
					var u = r.u[i];

					if (u.c == 1) {
						this.nodes[u.u] = {
							name: u.m,
							type: NodeType.CONTACT,
							handle: u.u,
							parent_handle: '*NETWORK',
							size: 0,
							mtime: u.ts
						};
					}
				}
			}

			this.mapPaths();
			this.mapChildren();
		}, this);
	},

	getNodeByHandle: function(handle) {
		return this.nodes[handle];
	},

	mapPaths: function() {
                this.pathMap = {};

		for (var handle in this.nodes) {
			var node = this.nodes[handle];

			node.path = this.getNodePath(node);
			if (node.path) {
				if (this.pathMap[node.path]) {
					node.path += '.' + node.handle;
				}

				this.pathMap[node.path] = node;
			}
		}
	},

	getPaths: function() {
		var paths = [];

		for (var path in this.pathMap) {
			paths.push(path);
		}

		return paths.sort();
	},

	getNodeByPath: function(path) {
		return this.pathMap[path];
	},

	getNodePath: function(node) {
		var parts = [];
		while (node) {
			parts.push(node.name);
			node = this.nodes[node.parent_handle] || this.nodes[node.su_handle];
		}

		parts.reverse();
		return parts.join('/');
	},

	mapChildren: function() {
		this.children = {};

		for (var handle in this.nodes) {
			var node = this.nodes[handle], children;
			if (node.parent_handle) {
				children = this.children[node.parent_handle];
				if (children) {
					children.push(node);
				} else {
					this.children[node.parent_handle] = [node];
				}
			}

			if (node.su_handle) {
				children = this.children[node.su_handle];
				if (children) {
					children.push(node);
				} else {
					this.children[node.su_handle] = [node];
				}
			}
		}
	},

	getChildren: function(node) {
		return this.children[node.handle] || [];
	},

	getShareKey: function(handle) {
		return this.share_keys[handle];
	},

	setShareKey: function(handle, key) {
		this.share_keys[handle] = key;
	}
});

