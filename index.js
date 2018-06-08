const app = require('express')();
const bodyParser = require('body-parser');
const cors = require('cors')
const uuidV4 = require('uuid/v4');
const fs = require('fs');
const spawn = require('child_process').spawn;
const exec = require('child_process').exec;
const path = require('path');
const winston = require('winston');
const moment = require('moment');
const sprintf = require('sprintf-js').sprintf;
const server = require('http').createServer(app);  
const io = require('socket.io')(server);
const multer  = require('multer');
const ni = require('network-interfaces');
const cap = require('cap').Cap;
app.use(cors())
app.use(bodyParser.json());

const buildProperties = require('./build-properties');
const version = `${buildProperties.major}.${buildProperties.minor}.${buildProperties.patch}.${buildProperties.build}-${buildProperties.level}`;
const listenPort = 3003;

var development = true;
var debug = true;

//////////////// APP DATA ////////////////
var preferences = {};
var playlists = [];
var pcaps = [];
var nics = [];

//////////////// LOGGING ////////////////

winston.remove(winston.transports.Console);
let tOptions = {
  'timestamp': () => moment().format('YYYY-MM-DD HH:mm:ss,SSS') + ' ',
  'formatter': (options) => options.timestamp() + 'tcp-repeat    ' + sprintf('%-10s', options.level.toUpperCase()) + ' ' + (options.message ? options.message : '') +(options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' )
};
if ('SYSTEMD' in process.env) {
  // systemd journal adds its own timestamp
  tOptions.timestamp = null;
  tOptions.formatter = (options) => systemdLevelFormatter(options.level) + 'afb_server    ' + (options.message ? options.message : '') + (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
}
winston.add(winston.transports.Console, tOptions);
winston.info('Starting tcp-repeat-server version', version);
if (development) {
  winston.level = 'debug';
  winston.debug('tcp-repeat-server is running in development mode');
}
else {
  winston.level = 'info';
}

if (debug) {
  winston.debug('tcp-repeat-server debug logging is enabled');
  winston.level = 'debug';
}



//////////////// READ PREFERENCES ////////////////

const prefsDir = './etc';
const prefsFile = `${prefsDir}/tcp-repeat-settings.json`;
const pcapsFile = `${prefsDir}/pcaps.json`;
const playlistsFile = `${prefsDir}/playlists.json`;
var prefsFileHandle = fs.openSync(prefsFile, 'r+') || null;
if (!prefsFileHandle) {
  winston.error(`Could not open preferences file ${prefsFile}`);
  process.exit(1);
}
preferences = JSON.parse(fs.readFileSync(prefsFileHandle));
winston.debug('preferences:', preferences);

// Check for tcpreplay
var tcpreplayFound = false;
function checkForTcpreplay() {
  if (fs.existsSync(preferences.pathToTcpreplay) ) {
    // now try to execute tcpreplay
    exec(preferences.pathToTcpreplay + ' --help', (err, stdout, stderr) => {
    if (err) {
      winston.warn('tcpreplay was found but could not be executed');
      tcpreplayFound = false;
      return;
    }
    winston.info('\'tcpreplay --help\' ran successfully');
    tcpreplayFound = true;
    });
  }
  else {
    winston.warn('tcpreplay was not found');
    tcpreplayFound = false;
  }
}
checkForTcpreplay();
// Multipart upload config
if (! ('pcapsDir' in preferences)) {
  winston.error('Could not find pcapsDir in preferences.  Exiting');
  process.exit(1);
}
if (! fs.existsSync(preferences.pcapsDir)) {
  winston.error('PCAPs directory not found:', preferences.pcapsDir + '.  Exiting');
  process.exit(1);
}
try {
  fs.accessSync(preferences.pcapsDir, fs.constants.W_OK);
}
catch(err) {
  winston.error('PCAPs directory is not writeable by the current user.  Exiting');
  process.exit(1);
}
const upload = multer({ dest: preferences.pcapsDir })



//////////////// READ DATA ////////////////

//////////////// READ INTERFACES ////////////////

function readNics() {
  let exclude = [ 'any', 'nflog', 'nfqueue' ];
  let list = cap.deviceList();
  let nicList = [];
  for (let i=0; i < list.length; i++) {
    let nic = list[i];
    if (!exclude.includes(nic.name)) {
      nicList.push(nic);
    }
  }
  return nicList;
}
nics = readNics();
// winston.debug('nics:', nics);



// read pcaps
if (fs.existsSync(pcapsFile)) {
  var pcapsFileHandle = fs.openSync(pcapsFile, 'r+') || null;
  pcaps = JSON.parse(fs.readFileSync(pcapsFileHandle));
  fs.closeSync(pcapsFileHandle);
}
winston.debug('pcaps:', pcaps);



// read playlists
if (fs.existsSync(playlistsFile)) {
  var playlistsFileHandle = fs.openSync(playlistsFile, 'r+');
  try {
    playlists = JSON.parse(fs.readFileSync(playlistsFileHandle));
  }
  catch(err) {
    playlists = [];
  }
  fs.closeSync(playlistsFileHandle);
  playlists[0]['pcaps'] = [];
}
if (playlists.length === 0 || (playlists.length !== 0 && playlists[0].name !== 'All' ) ) {
  // create 'all' playlist
  let all = {
    name: 'All',
    count: 0,
    pcaps: [], // an array of pcap id's
    settings: {
      speed: 'pcap',
      interface: null,
      looping: 'none'
    },
    pcapSettings: {}
  };
  if (nics.length !== 0) {
    // set default All interface to first NIC
    all.settings.interface = nics[0].name;
  }
  playlists.unshift(all);
}
// add pcaps to 'all' playlist
for (let i = 0; i < pcaps.length; i++) {
  let pcap = pcaps[i];
  let id = pcap.id;
  let all = playlists[0];
  all.pcaps.push(pcap.id);
}
for (let i = 0; i < playlists.length; i++) {
  // generate counts for playlists
  let pl = playlists[i];
  pl['count'] = pl.pcaps.length;
}
winston.debug('pcaps:', pcaps);
winston.debug('playlists:', playlists);



//////////////// WRITE DATA ////////////////

function writeData(filename, data) {
  fs.open(filename, 'w', (err, fh) => {
    fs.write(fh, data, 0, 'utf8', err => {
      if (err) {
        throw(err);
      }
      fs.close(fh, error => {
        if (error) {
          throw(error);
        }
      });
    });
  });
}




//////////////// API CALLS ////////////////


app.post('/api/preferences', (req, res) => {
  // update preferences
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  try {
    let prefs = req.body;
    if (! ('pathToTcpreplay' in prefs) ) {
      throw('\'pathToTcpreplay\' was not found in prefs');
    }
    if (! ('pcapsDir' in prefs) ) {
      throw('\'pcapsDir\' was not found in prefs');
    }
    preferences = preferences;
    io.emit('preferences', preferences); // update clients
    fs.writeFile(prefsFileHandle, JSON.stringify(preferences), err => {
      if (err) {
        throw(`Could not write preferences file ${prefsFile}`)
      }
    });
    res.status(200).send( JSON.stringify( { success: true } ) );
  }
  catch(err) {
    winston.error("POST /api/preferences: " + err);
    res.status(500).send( JSON.stringify( { success: false, error: e.message || e } ) );
  }
});


//////////////// PLAYLISTS ////////////////

function writePlaylists() {
  let playlistTemp = JSON.parse(JSON.stringify(playlists));
  delete playlistTemp[0].pcaps;
  // delete playlistTemp[0].count;
  for (let i = 0; i < playlistTemp.length; i++) {
    // delete counts - they should be dynamic and they don't belong in the file
    let pl = playlistTemp[i];
    delete pl.count;
  }
  writeData(playlistsFile, JSON.stringify(playlistTemp));
}



app.get('/api/playlist/:name', (req, res) => {
  // adds a new playlist
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  let name = req.params.name;
  for (let i = 0; i < playlists; i++) {
    // check that name does not exist
    let pl = playlists[i];
    if (name === pl.name) {
      res.status(400).send( JSON.stringify( { success: false, error: 'Playlist exists' } ) );
      break;
    }
  }
  let playlist = {
    name: name,
    count: 0,
    pcaps: [],
    settings: {
      speed: 'pcap',
      interface: playlists[0].settings.interface,
      looping: 'none'
    },
    pcapSettings: {}
  };
  playlists.push(playlist);
  io.emit('playlists', playlists);
  // writeData(playlistsFile, JSON.stringify(playlists));
  writePlaylists();
  res.status(201).send( JSON.stringify( { success: true } ) );
});



app.post('/api/playlist/update', (req, res) => {
  // updates a playlist and its settings
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  let playlist = req.body;
  let name = playlist.name;
  for (let i = 0; i < playlists.length; i++) {
    let pl = playlists[i];
    if (name === pl.name) {
      playlist.count = playlist.pcaps.length;
      playlists[i] = playlist;
      break;
    }
  }
  io.emit('playlists', playlists);
  // writeData(playlistsFile, JSON.stringify(playlists));
  writePlaylists();
  res.status(200).send( JSON.stringify( { success: true } ) );
});



app.delete('/api/playlist/:name', (req, res) => {
  // delete a playlist
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  let name = req.params.name;
  for (let i = 0; i < playlists.length; i++) {
    let playlist = playlists[i];
    if (name === playlist.name) {
      playlists.splice(i, 1);
      break;
    }
  }
  io.emit('playlists', playlists);
  // writeData(playlistsFile, JSON.stringify(playlists));
  writePlaylists();
  res.status(200).send( JSON.stringify( { success: true } ) );
});



app.get('/api/playlist/play/:id', (req, res) => {
  // plays a playlist of pcaps
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  res.status(200).send( JSON.stringify( { success: true } ) );
});



//////////////// PCAPs ////////////////

function updateAllPlaylist() {
  let pcapsIds = [];
  for (let i = 0; i < pcaps.length; i++) {
    let pcap = pcaps[i];
    pcapsIds.push(pcap.id);
  }
  playlists[0].pcaps = pcapsIds;
  playlists[0].count = pcapsIds.length;
  io.emit('playlists', playlists);
}



app.post('/api/pcap/delete', (req, res) => {
  // deletes one or more pcaps
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  let idsToDelete = req.body;
  
  for (let x = 0; x < idsToDelete.length; x++) {

    let id = idsToDelete[x];

    let found = false;
    for (let i = 0; i < pcaps.length; i++) {
      let pcap = pcaps[i];
      if (pcap.id === id) {
        found = true;
        break;
      }
    }
    if (!found) {
      winston.warn(`PCAP with id ${id} not found`);
      res.status(500).send( JSON.stringify( { success: false, error: 'PCAP not found' } ) );
      return;
    }

    for (let i = 0; i < pcaps.length; i++) {
      let pcap = pcaps[i];
      if (pcap.id === id) {
        try {
          fs.unlinkSync(`${preferences.pcapsDir}/${pcap.filename}`);
        }
        catch(err) {
          if (err.code === 'ENOENT') {
            winston.warn(`PCAP file ${pcap.filename} was not found`);
          }
          else if (err) {
            winston.warn(`An error was encountered when deleting pcap ${pcap.filename}:`, err);
            res.status(500).send( JSON.stringify( { success: false, error: err } ) );
            return;
          }
        }
        pcaps.splice(i, 1);
        break;
      }
    }
  }

  for (let i = 1; i < playlists.length; i++) {
    // remove pcaps from playlists (except 'All')
    // loop through playlists
    let pl = playlists[i];
    let positionsToDelete = [];
    for (let x = 0; x < pl.pcaps.length; x++) {
      // loop through pcap id's in the playlist
      let id = pl.pcaps[x];
      if (idsToDelete.includes(id)) {
        positionsToDelete.push(x);
      }
    }
    positionsToDelete.sort( (a, b) => {return b - a;} );
    for (let y = 0; y < positionsToDelete.length; y++) {
      let pos = positionsToDelete[y];
      pl.pcaps.splice(pos, 1);
      pl.count--;
    }
  }

  io.emit('pcaps', pcaps);
  writeData(pcapsFile, JSON.stringify(pcaps));
  updateAllPlaylist();
  res.status(200).send( JSON.stringify( { success: true } ) );
});



app.post('/api/pcap/upload/:playlistName', upload.array('file[]'), (req, res) => {
  // upload one or more pcaps
  let playlistName = req.params.playlistName;
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  // winston.log(req.files);
  let time = moment().unix();
  let updatePlaylists = false;
  for (let i = 0; i < req.files.length; i++) {
    let file = req.files[i];
    let id = uuidV4();
    let pcap = {
      'id': id,
      'filename': file.filename,
      'size': file.size,
      'originalFilename': file.originalname,
      'time': time
    }
    pcaps.push(pcap);
    if (playlistName !== 'All') {
      for (let i = 0; i < playlists.length; i++) {
        let pl = playlists[i];
        if (pl.name === playlistName) {
          pl.pcaps.push(pcap.id);
          pl.count++;
          updatePlaylists = true;
          break;
        }
      }
    }
  }
  writeData(pcapsFile, JSON.stringify(pcaps));
  io.emit('pcaps', pcaps);
  updateAllPlaylist();
  writePlaylists();
  res.status(201).send( JSON.stringify( { success: true } ) );
});



app.get('/api/pcap/:id', (req, res) => {
  // download a pcap
  let id = req.id;
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
});



app.post('/api/pcap/edit', (req, res) => {
  // edit a pcap
  winston.debug(`${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
  res.status(200).send( JSON.stringify( { success: true } ) );
});



//////////////// SOCKET.IO ////////////////

function onSocketIoConnect(socket) {
  ioSocket = socket;
  winston.debug('A socket client connected');
  socket.on('disconnect', () => onSocketIoDisconnect() );

  // immediately send configuration to client
  socket.emit('serverVersion', version);
  socket.emit('preferences', preferences);
  socket.emit('tcpreplayFound', tcpreplayFound); // tell the client whether it can execute tcpreplay
  socket.emit('networkInterfaces', nics);
  socket.emit('pcaps', pcaps);
  socket.emit('playlists', playlists);
}
io.on('connection', (socket) => onSocketIoConnect(socket) );

function onSocketIoDisconnect(socket) {
  winston.debug('A socket client disconnected');
}


//////////////// Load express ////////////////
server.listen(listenPort);

winston.info('Listening on port', listenPort);
