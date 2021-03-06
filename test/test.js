var tapeTest = require('tape')
var Store = require('safe-fs-blob-store')
var tmp = require('tempy')
var rimraf = require('rimraf')
var fs = require('fs')
var path = require('path')
var replicate = require('..')
var http = require('http')
var websocket = require('websocket-stream')

function test (name, run) {
  tapeTest(name, function (t) {
    var dir = tmp.directory()
    run(t, dir, cleanup)
    function cleanup () {
      rimraf.sync(dir)
    }
  })
}

test('empty <-> empty', function (t, dir, done) {
  var root1 = path.join(dir, '1')
  var store1 = Store(root1)
  var root2 = path.join(dir, '2')
  var store2 = Store(root2)

  replicateStores(store1, store2, check)

  function check (err) {
    t.error(err)
    done()
    t.end()
  }
})

test('1 file <-> empty', function (t, dir, done) {
  t.plan(5)

  var root1 = path.join(dir, '1')
  var store1 = Store(root1)
  var root2 = path.join(dir, '2')
  var store2 = Store(root2)

  var ws = store1.createWriteStream('2010-01-01_foo.png')
  ws.on('finish', function () {
    replicateStores(store1, store2, check)
  })
  ws.on('error', function (err) {
    t.error(err)
  })
  ws.write('hello')
  ws.end()

  function check (err) {
    t.error(err)
    store1.exists('2010-01-01_foo.png', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in original store')
    })
    store2.exists('2010-01-01_foo.png', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in remote store')
    })
    done()
  }
})

test('replication stream: 3 files <-> 2 files (1 common)', function (t, dir, done) {
  t.plan(26)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var pending = 5
  writeFile(store1, '2010-01-01_foo.png', 'hello', written)
  writeFile(store1, '2010-01-05_bar.png', 'goodbye', written)
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '1900-01-01_first.png', 'elder', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err)
    if (--pending === 0) replicateStores(store1, store2, check)
  }

  function check (err) {
    t.error(err)

    // Four files in each store
    t.equal(fs.readdirSync(root1).length, 3)
    t.equal(fs.readdirSync(root2).length, 3)

    // Two files in the 2010-01 subdir
    t.equal(fs.readdirSync(path.join(root1, '2010-01')).length, 2)
    t.equal(fs.readdirSync(path.join(root2, '2010-01')).length, 2)

    // Check all files: store 1
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root1, '1976-12')))
    t.equal(fs.readFileSync(path.join(root1, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')
    t.ok(fs.existsSync(path.join(root1, '1900-01')))
    t.equal(fs.readFileSync(path.join(root1, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    // Check all files: store 2
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root2, '1976-12')))
    t.equal(fs.readFileSync(path.join(root2, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')
    t.ok(fs.existsSync(path.join(root2, '1900-01')))
    t.equal(fs.readFileSync(path.join(root2, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    done()
  }
})

test('websocket replication', function (t, dir, done) {
  t.plan(4)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var wss, web

  writeFile(store1, 'foo.txt', 'bar', function (err) {
    t.error(err)

    // server
    web = http.createServer()
    web.listen(2389)
    wss = websocket.createServer({server:web}, function (socket) {
      var rs = replicate(store2)
      socket.pipe(rs).pipe(socket)
      rs.on('end', done.bind(null, 'rs'))
      socket.on('end', done.bind(null, 'socket'))
    })

    // client
    var ws = websocket(`ws://localhost:2389`, {
      perMessageDeflate: false,
      binary: true
    })
    var r1 = replicate(store1)
    r1.pipe(ws).pipe(r1)
    r1.on('end', done.bind(null, 'r1'))
    ws.on('end', done.bind(null, 'ws'))
  })

  var pending = 4
  function done (name) {
    if (!--pending) {
      t.ok(true, 'replication ended')
      t.ok(fs.existsSync(path.join(root2, 'foo', 'foo.txt')))
      t.equal(fs.readFileSync(path.join(root2, 'foo', 'foo.txt'), 'utf8'), 'bar')

      web.close(done)
    }
  }
})

test('pull-mode: 3 files <-> 2 files (1 common)', function (t, dir, done) {
  t.plan(24)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var pending = 5
  writeFile(store1, '2010-01-01_foo.png', 'hello', written)
  writeFile(store1, '2010-01-05_bar.png', 'goodbye', written)
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '1900-01-01_first.png', 'elder', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err)
    if (--pending === 0) replicateStores(store1, store2, { s1: { mode: 'pull' } }, check)
  }

  function check (err) {
    t.error(err)

    t.equal(fs.readdirSync(root1).length, 3)
    t.equal(fs.readdirSync(root2).length, 2)

    // Two files in the 2010-01 subdir
    t.equal(fs.readdirSync(path.join(root1, '2010-01')).length, 2)
    t.equal(fs.readdirSync(path.join(root2, '2010-01')).length, 1)

    // Check all files: store 1
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root1, '1976-12')))
    t.equal(fs.readFileSync(path.join(root1, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')
    t.ok(fs.existsSync(path.join(root1, '1900-01')))
    t.equal(fs.readFileSync(path.join(root1, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    // Check all files: store 2
    t.ok(fs.existsSync(path.join(root2, '1900-01')))
    t.equal(fs.readFileSync(path.join(root2, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.notOk(fs.existsSync(path.join(root2, '2010-01', '2010-01-01_foo.png'), 'utf8'))
    t.notOk(fs.existsSync(path.join(root2, '1976-12', '1976-12-17_quux.png'), 'utf8'))

    done()
  }
})

test('push-mode: 3 files <-> 2 files (1 common)', function (t, dir, done) {
  t.plan(24)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var pending = 5
  writeFile(store1, '2010-01-01_foo.png', 'hello', written)
  writeFile(store1, '2010-01-05_bar.png', 'goodbye', written)
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '1900-01-01_first.png', 'elder', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err)
    if (--pending === 0) replicateStores(store1, store2, { s2: { mode: 'push' } }, check)
  }

  function check (err) {
    t.error(err)

    // Four files in each store
    t.equal(fs.readdirSync(root1).length, 3)
    t.equal(fs.readdirSync(root2).length, 2)

    // Two files in the 2010-01 subdir
    t.equal(fs.readdirSync(path.join(root1, '2010-01')).length, 2)
    t.equal(fs.readdirSync(path.join(root2, '2010-01')).length, 1)

    // Check all files: store 1
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root1, '1976-12')))
    t.equal(fs.readFileSync(path.join(root1, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')
    t.ok(fs.existsSync(path.join(root1, '1900-01')))
    t.equal(fs.readFileSync(path.join(root1, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    // Check all files: store 2
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root2, '1900-01')))
    t.equal(fs.readFileSync(path.join(root2, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')
    t.notOk(fs.existsSync(path.join(root2, '2010-01', '2010-01-01_foo.png'), 'utf8'))
    t.notOk(fs.existsSync(path.join(root2, '1976-12', '1976-12-17_quux.png'), 'utf8'))

    done()
  }
})

test('both sides in push-mode: no files xferred', function (t, dir, done) {
  t.plan(11)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var pending = 2
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err)
    var opts = {
      s1: { mode: 'push' },
      s2: { mode: 'push' }
    }
    if (--pending === 0) replicateStores(store1, store2, opts, check)
  }

  function check (err) {
    t.error(err)

    t.equal(fs.readdirSync(root1).length, 1)
    t.equal(fs.readdirSync(root2).length, 1)

    t.equal(fs.readdirSync(path.join(root1, '1976-12')).length, 1)
    t.equal(fs.readdirSync(path.join(root2, '2010-01')).length, 1)

    // Check all files: store 1
    t.ok(fs.existsSync(path.join(root1, '1976-12')))
    t.equal(fs.readFileSync(path.join(root1, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')

    // Check all files: store 2
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')

    done()
  }
})

test('subdirectory', function (t, dir, done) {
  t.plan(5)

  var root1 = path.join(dir, '1')
  var store1 = Store(root1)
  var root2 = path.join(dir, '2')
  var store2 = Store(root2)

  var ws = store1.createWriteStream('original/fa1ee1d1b61d9afcc99b1a8bd9b690ac.jpg')
  ws.on('finish', function () {
    replicateStores(store1, store2, check)
  })
  ws.on('error', function (err) {
    t.error(err)
  })
  ws.write('hello')
  ws.end()

  function check (err) {
    t.error(err)
    store1.exists('original/fa1ee1d1b61d9afcc99b1a8bd9b690ac.jpg', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in original store')
    })
    store2.exists('original/fa1ee1d1b61d9afcc99b1a8bd9b690ac.jpg', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in remote store')
    })
    done()
  }
})

test('opts.filter', function (t, dir, done) {
  t.plan(24)

  function filterFn (name) {
    return /foo/.test(name)
  }

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})

  var pending = 5
  writeFile(store1, '2010-01-01_foo.png', 'hello', written)
  writeFile(store1, '2010-01-05_bar.png', 'goodbye', written)
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '1900-01-01_first.png', 'elder', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err)
    if (--pending === 0) replicateStores(store1, store2, {s1:{filter:filterFn}}, check)
  }

  function check (err) {
    t.error(err)

    // Four files in each store
    t.equal(fs.readdirSync(root1).length, 3)
    t.equal(fs.readdirSync(root2).length, 2)

    // Two files in the 2010-01 subdir
    t.equal(fs.readdirSync(path.join(root1, '2010-01')).length, 2)
    t.equal(fs.readdirSync(path.join(root2, '2010-01')).length, 2)

    // Check all files: store 1
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.ok(fs.existsSync(path.join(root1, '2010-01')))
    t.equal(fs.readFileSync(path.join(root1, '2010-01', '2010-01-05_bar.png'), 'utf8'), 'goodbye')
    t.ok(fs.existsSync(path.join(root1, '1976-12')))
    t.equal(fs.readFileSync(path.join(root1, '1976-12', '1976-12-17_quux.png'), 'utf8'), 'unix')
    t.ok(fs.existsSync(path.join(root1, '1900-01')))
    t.equal(fs.readFileSync(path.join(root1, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    // Check all files: store 2
    t.ok(fs.existsSync(path.join(root2, '2010-01')))
    t.equal(fs.readFileSync(path.join(root2, '2010-01', '2010-01-01_foo.png'), 'utf8'), 'hello')
    t.notOk(fs.existsSync(path.join(root2, '1976-12')))
    t.notOk(fs.existsSync(path.join(root2, '1976-12', '1976-12-17_quux.png')))
    t.ok(fs.existsSync(path.join(root2, '1900-01')))
    t.equal(fs.readFileSync(path.join(root2, '1900-01', '1900-01-01_first.png'), 'utf8'), 'elder')

    done()
  }
})

test('size zero file', function (t, dir, done) {
  t.plan(5)

  var root1 = path.join(dir, '1')
  var store1 = Store(root1)
  var root2 = path.join(dir, '2')
  var store2 = Store(root2)

  var ws = store1.createWriteStream('empty.txt')
  ws.on('finish', function () {
    replicateStores(store1, store2, check)
  })
  ws.on('error', function (err) {
    t.error(err)
  })
  ws.end()

  function check (err) {
    t.error(err)
    store1.exists('empty.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in original store')
    })
    store2.exists('empty.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'exists in remote store')
    })
    done()
  }
})

test('size zero file + a non-zero file', function (t, dir, done) {
  t.plan(11)

  var root1 = path.join(dir, '1')
  var store1 = Store(root1)
  var root2 = path.join(dir, '2')
  var store2 = Store(root2)

  var pending = 2

  var ws1 = store1.createWriteStream('empty.txt')
  ws1.on('finish', done)
  ws1.on('error', done)
  ws1.end()

  var ws2 = store1.createWriteStream('hello.txt')
  ws2.on('finish', done)
  ws2.on('error', done)
  ws2.end('hello world')

  function done (err) {
    t.error(err)
    if (!--pending) replicateStores(store1, store2, check)
  }

  function check (err) {
    t.error(err)
    store1.exists('empty.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'empty.txt exists in original store')
    })
    store1.exists('hello.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'hello.txt exists in original store')
    })
    store2.exists('empty.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'empty.txt exists in remote store')
    })
    store2.exists('hello.txt', function (err, exists) {
      t.error(err)
      t.ok(exists, 'hello.txt exists in remote store')
    })
  }
})

test('progress events', function (t, dir, done) {
  t.plan(11)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})
  var lastSofarA, lastTotalA
  var lastSofarB, lastTotalB

  var pending = 5
  writeFile(store1, '2010-01-01_foo.png', 'hello', written)
  writeFile(store1, '2010-01-05_bar.png', 'goodbye', written)
  writeFile(store1, '1976-12-17_quux.png', 'unix', written)
  writeFile(store2, '1900-01-01_first.png', 'elder', written)
  writeFile(store2, '2010-01-05_bar.png', 'goodbye', written)

  function written (err) {
    t.error(err, 'file setup write ok')
    if (--pending === 0) {
      sync()
    }
  }

  function sync () {
    var r1 = replicate(store1)
    var r2 = replicate(store2)

    r1.on('progress', function (sofar, total) {
      lastSofarA = sofar
      lastTotalA = total
    })
    r2.on('progress', function (sofar, total) {
      lastSofarB = sofar
      lastTotalB = total
    })

    r1.pipe(r2).pipe(r1)
    r1.on('end', fin)
    r1.on('error', fin)
    r2.on('end', fin)
    r2.on('error', fin)

    var pending = 2
    function fin (err) {
      t.error(err, 'sync ok')
      if (!--pending) check()
    }
  }

  function check () {
    t.equals(lastSofarA, 3, 'sofar A good')
    t.equals(lastTotalA, 3, 'total A good')
    t.equals(lastSofarB, 3, 'sofar B good')
    t.equals(lastTotalB, 3, 'total B good')
    done()
  }
})

test('lots of blobs', function (t, dir, done) {
  t.plan(4)

  var root1 = path.join(dir, '1')
  var store1 = Store({path: root1, subDirPrefixLen: 7})
  var root2 = path.join(dir, '2')
  var store2 = Store({path: root2, subDirPrefixLen: 7})
  var lastSofarA, lastTotalA
  var lastSofarB, lastTotalB

  function write (store, n, cb) {
    if (!n) return cb()
    writeFile(store, String(Math.random()).substring(3) + '.png', Buffer.alloc(1024 * 100).fill(0), function () {
      write(store, n-1, cb)
    })
  }

  write(store1, 200, function (err) {
    t.error(err, 'setup ok')
    sync()
  })

  function slow (delay) {
    return through((chunk, enc, next) => {
      setTimeout(() => {
        next(null, chunk)
      }, delay)
    })
  }

  function sync () {
    var r1 = replicate(store1)
    var r2 = replicate(store2)

    r1.pipe(r2).pipe(r1)
    r2.on('end', fin)
    r2.on('error', fin)

    function fin (err) {
      t.error(err, 'sync ok')
      store2.list(function (err, files) {
        t.error(err, 'list ok')
        t.same(files.length, 200, '# of files on remote ok')
        done()
      })
    }
  }
})

function replicateStores (s1, s2, opts, cb) {
  if (!cb && typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  opts.s1 = opts.s1 || {}
  opts.s2 = opts.s2 || {}

  var r1 = replicate(s1, opts.s1)
  var r2 = replicate(s2, opts.s2)

  r1.pipe(r2).pipe(r1)
  r1.on('end', check)
  r1.on('error', check)
  r2.on('end', check)
  r2.on('error', check)

  var pending = 2
  function check (err) {
    if (err) {
      pending = Infinity
      cb(err)
    }
    if (!--pending) cb()
  }
}

function writeFile (store, name, data, done) {
  var ws = store.createWriteStream(name)
  ws.on('finish', done)
  ws.on('error', done)
  ws.write(data)
  ws.end()
}

