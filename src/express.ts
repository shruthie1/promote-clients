import express from 'express';
import cors from 'cors';
import { fetchWithTimeout } from './fetchWithTimeout';
import { parseError } from './parseError';
import { sendPing } from './connection';
import { ppplbot, sendToLogs, sleep } from './utils';
import * as schedule from 'node-schedule-tz';
import { execSync } from 'child_process';
import { TelegramService } from './Telegram.service';
import { UserDataDtoCrud } from './dbservice';
import { Api } from 'telegram';

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
  startTime: number,
  daysLeft: number
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

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`${process.env.clientId}-Prom : UNHANDLED - ${reason}`)}`);
  } catch (error) {
    console.log(error)
  }
});

schedule.scheduleJob('test3', '*/5 * * * *', 'Asia/Kolkata', async () => {
  await checkHealth()
})

schedule.scheduleJob('test3', '25 0 * * *', 'Asia/Kolkata', async () => {
  const db = UserDataDtoCrud.getInstance();
  await db.resetPromoteClientStats()
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

app.get('/getClients', async (req, res) => {
  res.json(await getALLClients())
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
    parseError(error, "Error Executing ");
  }
});

app.get('/getPromotionResults', async (req, res) => {
  try {
    const telegramService = TelegramService.getInstance();
    res.json(telegramService.getPromotionResults());
  } catch (error) {
    parseError(error, "Error Executing ");
  }
});

app.get('/getMobileStats', async (req, res) => {
  try {
    const telegramService = TelegramService.getInstance();
    res.json(telegramService.getMobileStats());
  } catch (error) {
    parseError(error, "Error Executing ");
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
          const db = UserDataDtoCrud.getInstance()
          await db.connect()
          await db.updatePromoteClientStat({ clientId: process.env.clientId }, { lastStarted: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) });
          setTimeout(() => {
            canTry2 = true;
          }, 70000);
          let canStart = true
          const resp = await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`Starting ${process.env.clientId} Promotions`)}`);
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
    parseError(error, "Error At Connecting");
  }
});

function extractNumberFromString(str) {
  const match = str.match(/\d+/);
  return match;
}

async function startConn() {
  console.log("Starting connections")
  const result = await fetchWithTimeout(`${process.env.promoteChecker}/forward/clients/${process.env.clientId}`);
  const client = result?.data;
  console.log("Client: ", client)
  for (const mobile of client.promoteMobile) {
    console.log(mobile)
    clientsMap.set(mobile, {
      clientId: client.clientId,
      mobile: mobile,
      repl: client.repl,
      username: client.username,
      lastMessage: Date.now(),
      name: client.name,
      startTime: Date.now(),
      daysLeft: -1
    })
  }
  const telegramService = TelegramService.getInstance();
  await telegramService.connectClients()
}

async function getALLClients() {
  const db = UserDataDtoCrud.getInstance();
  const result = await db.getPromoteClientStats()

  return result
}
export async function checkHealth() {
  console.log("============Checking Health==============");
  const telegramService = TelegramService.getInstance();
  await telegramService.saveMobileStats();
  const clientData = await (UserDataDtoCrud.getInstance()).getClient({ clientId: process.env.clientId });
  const averageReactionDelay = telegramService.getAverageReactionDelay()
  const lastReactedTime = telegramService.getLastReactedTime()
  await sendToLogs({ message: `\nAverage Reaction Delay: ${averageReactionDelay}: last:${((Date.now() - lastReactedTime) / 60000).toFixed(2)}mins` });
  if (lastReactedTime < Date.now() - 5 * 60 * 1000) {
    console.log("Exiting as reactions failed: ", lastReactedTime, " : ", Date.now() - 5 * 60 * 1000)
    process.exit(1);
  }
  await telegramService.setMobiles(clientData.promoteMobile);
  for (const mobile of clientData.promoteMobile) {
    await sleep(1000);
    try {
      const client = clientsMap.get(mobile);
      if (client) {
        const clientDetails = {
          clientId: client.clientId,
          mobile: mobile,
          repl: client.repl,
          username: client.username,
          lastMessage: Date.now(),
          name: client.name,
          startTime: client?.startTime || Date.now(),
          daysLeft: client.daysLeft,
        };
        try {
          const telegramManager = telegramService.getClient(mobile);
          if (telegramManager) {
            try {
              const me = await telegramManager.getMe();
              if (me.phone !== clientDetails.mobile) {
                console.log(clientDetails.mobile, " : mobile changed", " me : ", me, "clientDetails: ", clientDetails);
                clientsMap.set(mobile, clientDetails);
                await restartClient(mobile);
              } else {
                const lastMessageTime = telegramService.getLastMessageTime(mobile);
                const timeInMins = ((Date.now() - lastMessageTime) / 60000).toFixed(2)
                if (lastMessageTime < Date.now() - 15 * 60 * 1000) {
                  console.log(
                    clientDetails.clientId,
                    " : Promotions Seems stopped - ",
                    `LastMSg : ${timeInMins} mins ago`,
                    `DaysLeft: ${telegramService.getDaysLeft(mobile)}`
                  );
                  await telegramManager.checktghealth();
                  if (
                    telegramManager.daysLeft == -1 &&
                    lastMessageTime < Date.now() - 25 * 60 * 1000
                  ) {
                    console.log(
                      "Promotion stopped",
                      clientDetails.mobile,
                      "DaysLeft: ",
                      telegramService.getDaysLeft(mobile)
                    );
                    await sendToLogs({ message: `Promotion stopped for ${clientDetails.mobile}:\nLastMSg : ${timeInMins} mins ago` });
                    restartClient(mobile);
                  }
                  telegramService.startPromotion();
                } else {
                  console.log(
                    mobile,
                    me.username,
                    " : Promotions Working fine - ",
                    `LastMSg : ${timeInMins} mins ago`,
                    `DaysLeft: ${telegramService.getDaysLeft(mobile)}`
                  );
                }
                clientsMap.set(mobile, clientDetails);
                telegramManager.setClientDetails(clientDetails);
                setTimeout(async () => {
                  try {
                    await telegramManager?.checkMe();
                    await telegramManager.client.invoke(new Api.updates.GetState());
                    await telegramManager.client.markAsRead('myvcacc')
                    await telegramManager.setTyping('myvcacc')
                    setTimeout(async () => {
                      await telegramManager.client.invoke(new Api.updates.GetState());
                      await telegramManager.client.markAsRead('myvcacc')
                      await telegramManager.setTyping('myvcacc')
                    }, 150000);
                  } catch (e) {
                    parseError(e, `${mobile} Error at Health Check`);
                  }
                }, 30000);
              }
            } catch (e) {
              parseError(e, clientDetails.mobile);
            }
          } else {
            console.log("Does not Exist Client 1: ", clientDetails.mobile);
          }
        } catch (error) {
          console.log("Does not Exist Client 2: ", clientDetails.mobile);
        }
      } else {
        const clientDetails = {
          clientId: clientData.clientId,
          mobile: mobile,
          repl: clientData.repl,
          username: clientData.username,
          lastMessage: Date.now(),
          name: clientData.name,
          startTime: Date.now(),
          daysLeft: -1
        };
        clientsMap.set(mobile, clientDetails);
        await telegramService.createClient(clientDetails, false, true);
      }
    } catch (e) {
      parseError(e, "Error at Health Check");
    }
  }
  const promoteMobilesSet = new Set(clientData.promoteMobile);
  for (const mobile of clientsMap.keys()) {
    try {
      if (!promoteMobilesSet.has(mobile)) {
        console.log(`Removing old client entry from clientsMap: ${mobile}`);
        await telegramService.disposeClient(mobile);
        clientsMap.delete(mobile);
      }
    } catch (error) {
      parseError(error, "Error at Removing Old Client Entry");
    }
  }
  console.log("Average Reaction Delay: ", telegramService.getAverageReactionDelay());
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export function getMapValues() {
  return Array.from(clientsMap.values());
}

export function getMapKeys() {
  return Array.from(clientsMap.keys());
}

export function getClientDetails(mobile: string) {
  const client = clientsMap.get(mobile);
  return client;
}

export async function updateSuccessCount(clientId: string) {
  const db = UserDataDtoCrud.getInstance();
  await db.increaseSuccessCount(clientId);
}

export async function updateFailedCount(clientId: string) {
  const db = UserDataDtoCrud.getInstance();
  await db.increaseFailedCount(clientId);
}

export async function updateMsgCount(clientId: string) {
  const db = UserDataDtoCrud.getInstance();
  await db.increaseMsgCount(clientId);
}

export async function updatePromoteClient(clientId: string, clientData: any) {
  const db = UserDataDtoCrud.getInstance();
  await db.updatePromoteClientStat({ clientId }, { ...clientData });
}

export async function restartClient(mobile: string) {
  if (!mobile) {
    console.error(`ClientId ${mobile} is undefined`);
    return;
  }

  const telegramService = TelegramService.getInstance();
  const clientDetails = clientsMap.get(mobile);

  if (!clientDetails) {
    console.error(`Client details for ${mobile} do not exist`);
    return;
  }
  if (clientDetails.startTime > Date.now() - 1000 * 60 * 5) {
    console.log(`Client ${mobile} was started less than 5 minutes ago. Skipping restart.`);
    return;
  }

  console.log(`===================Restarting service : ${mobile.toUpperCase()}=======================`);

  try {
    const tgManager = await telegramService.getClient(mobile);

    if (tgManager) {
      await telegramService.disposeClient(mobile);
      await telegramService.createClient(clientDetails, false, true);
    } else {
      console.error(`TelegramManager instance not found for clientId: ${mobile}`);
    }
  } catch (error) {
    console.error(`Failed to restart client ${mobile}:`, error);
  }
}
