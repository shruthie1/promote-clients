import express from 'express';
import cors from 'cors';
import { fetchWithTimeout } from './fetchWithTimeout';
import { UserDataDtoCrud } from './dbservice';
import { parseError } from './parseError';
import { sendPing } from './connection';
import { ppplbot } from './utils';
import * as schedule from 'node-schedule-tz';
import { execSync } from 'child_process';
import { TelegramService } from './Telegram.service';

let canTry2 = true;

async function exitHandler(options, exitCode) {
  console.log("exitOptions: ", options)
  // await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}:ExitHandler | pid - ${process.pid} | code - ${exitCode}| options: ${JSON.stringify(options)}`);
  // if (options.cleanup) await (UserDataDtoCrud.getInstance()).closeConnection();
  // if (exitCode || exitCode === 0) console.log("exitCode: ", exitCode);
  // // if (options.exit) 
  await (UserDataDtoCrud.getInstance()).closeConnection()
  await TelegramService.getInstance().disconnectAll()
  process.exit(1);
}

export interface IClientDetails {
  clientId: string;
  mobile: string;
  repl: string;
  username: string;
  lastMessage: number;
  name: string;
}

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));
process.on('SIGINT', exitHandler.bind(null, {}));
process.on('SIGQUIT', exitHandler.bind(null, {}));
process.on('SIGHUP', exitHandler.bind(null, {}));
process.on('SIGUSR1', exitHandler.bind(null, {}));
process.on('SIGUSR2', exitHandler.bind(null, {}));
process.on('SIGTERM', exitHandler.bind(null, { exit: true }));

process.on('uncaughtException', async (err) => {
  console.log('------------An uncaught exception occurred:', err);
  try {
    await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}: UNCAUGHT - ${err}`);
    if (JSON.stringify(err).includes('MongoPoolClearedError')) {
      await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()} - Restarting DB`);
      await (UserDataDtoCrud.getInstance()).closeConnection();
      setTimeout(() => {
        UserDataDtoCrud.getInstance().connect()
      }, 15000);
    }
  } catch (error) {
    console.log(error)
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

schedule.scheduleJob('test3', '*/5 * * * *', 'Asia/Kolkata', async () => {
  await checkHealth()
})

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
export const prcessID = Math.floor(Math.random() * 123);
console.log("ProcessID: ", prcessID)
app.use(express.json());

const clientsMap: Map<string, IClientDetails> = new Map();
app.get('/', (req, res) => {
  res.send("Hello World");
})

app.get('/exit', (req, res, next) => {
  res.send("Exitting");
  next()
}, (req, res) => {
  process.exit(1);
})

app.get('/exec/:cmd', async (req, res) => {
  let cmd = req.params.cmd;
  console.log(`executing: `, cmd);
  try {
    res.send(console.log(execSync(cmd).toString()));
  } catch (error) {
    parseError(error);
  }
});

app.get('/getProcessId', async (req, res) => {
  res.json({ ProcessId: prcessID.toString() });
});

app.get('/restart/:clientId', async (req, res, next) => {
  res.send('OK');
  next();
}, async (req, res) => {
  const clientId = req.params.clientId;
  await restartClient(clientId)
});

app.get('/tryToConnect/:num', async (req, res, next) => {
  res.send('OK');
  next();
}, async (req, res) => {
  const receivePrcssId = parseInt(req.params?.num);
  console.log(prcessID, 'Connect Req received from: ', receivePrcssId);
  try {
    if (canTry2) {
      if (receivePrcssId === prcessID) {
        // const isAlive = await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}: Alive Check`);
        // if (isAlive) {
        await sleep(300);
        if (sendPing === false) {
          console.log('Trying to Initiate CLIENT');
          canTry2 = false;
          await UserDataDtoCrud.getInstance().connect()
          setTimeout(() => {
            canTry2 = true;
          }, 70000);
          let canStart = true
          for (let i = 0; i < 3; i++) {
            // const resp = await fetchWithTimeout(`${ppplbot()}&text=exit${process.env.username}`);
            // if (resp) {
            //   canStart = true;
            //   break;
            // }
          }
          await sleep(3000);
          // await fetchWithTimeout(`${ppplbot()}&text=exit${process.env.username}`);
          if (canStart) {
            // await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}: Connecting.......!!`);
            await startConn();
          }
          // } else {
          //     await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}: Pinging is Working`);
          // }
        } else {
          console.log('Issue at sending Pings')
        }
      }
      else {
        console.log('SomeOther Unknown Process Exist');
        await fetchWithTimeout(`${ppplbot()}&text=${(process.env.clientId).toUpperCase()}: SomeOther Unknown Process Exist`);
      }
    }
  } catch (error) {
    parseError(error);
  }
});

function extractNumberFromString(str) {
  const match = str.match(/\d+/);
  return match;
}

async function startConn() {
  console.log("Starting connections")
  const result = await fetchWithTimeout(`https://uptimechecker2.glitch.me/maskedcls`);
  const clients = result?.data;
  for (const client of clients) {
    if (extractNumberFromString(client.clientId) == process.env.clientNumber && client.promoteMobile) {
      clientsMap.set(client.clientId, {
        clientId: client.clientId,
        mobile: client.promoteMobile,
        repl: client.repl,
        username: client.username,
        lastMessage: Date.now(),
        name: client.name
      })
    }
  }
  const telegramService = TelegramService.getInstance();
  await telegramService.connectClients()
}

async function checkHealth() {
  console.log("============Checking Health==============")
  const telegramService = TelegramService.getInstance();
  const clients = await (UserDataDtoCrud.getInstance()).getClients()
  for (const clientData of clients) {
    const clientDetails: IClientDetails = {
      clientId: clientData.clientId,
      mobile: clientData.promoteMobile,
      repl: clientData.repl,
      username: clientData.username,
      lastMessage: Date.now(),
      name: clientData.name
    }
    const telegramManager = await telegramService.getClient(clientDetails.clientId);
    if (telegramManager) {
      const me = await telegramManager.getMe();
      if (me.phone !== clientDetails.mobile) {
        console.log(clientDetails.clientId, " : mobile changed");
        clientsMap.set(clientDetails.clientId, clientDetails)
        await restartClient(clientDetails.clientId)
      } else {

        if (telegramManager.getLastMessageTime() < Date.now() - 5 * 60 * 1000) {
          console.log(clientDetails.clientId, " : Promotions stopped - ", Math.floor((Date.now() - telegramManager.getLastMessageTime()) / 1000))
          await telegramManager.checktghealth()
          // await telegramService.deleteClient(client.clientId);
          // await sleep(5000);
          // await telegramService.createClient(clientDetails, false, true);
        } else {
          console.log(clientDetails.clientId, " : Promotions Working fine - ", Math.floor((Date.now() - telegramManager.getLastMessageTime()) / 1000))
        }
        clientsMap.set(clientDetails.clientId, clientDetails)
        telegramManager.setClientDetails(clientDetails)
      }
      setTimeout(async () => {
        await telegramManager.checkMe();
      }, 30000);
    } else {
      // console.log("Does not Exist Client: ", client.clientId)
    }
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export function getMapValues() {
  return Array.from(clientsMap.values())
}

export function getMapKeys() {
  return Array.from(clientsMap.keys())
}

export async function restartClient(clientId: string) {
  console.log(`===================Restarting service : ${clientId.toUpperCase()}=======================`)
  const telegramService = TelegramService.getInstance();
  await telegramService.deleteClient(clientId);
  await sleep(5000);
  const clientDetails = clientsMap.get(clientId);
  await telegramService.createClient(clientDetails, false, true)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
