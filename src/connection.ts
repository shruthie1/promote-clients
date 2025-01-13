import { fetchWithTimeout } from "./fetchWithTimeout";
import { parseError } from "./parseError";
import { ppplbot } from "./utils";
import { prcessID } from "./express";

let retryTime = 0;
export let sendPing = false;
export function setSendPing(value) {
    sendPing = value
}
setTimeout(async () => {
    await retryConnection();
    setInterval(async () => {
        await retryConnection();
    }, 120000)
}, 20000)

async function retryConnection() {
    if (sendPing) {
        try {
            // await fetchWithTimeout(`${process.env.promoteChecker}/receive?clientId=${process.env.repl}`, {}, false);
        } catch (error) {
            parseError(error, "Cannot fetch pinger:")
        }
        retryTime = 0
    } else {
        retryTime++;
        if (retryTime > 1) {
            // await fetchWithTimeout(`${ppplbot()}&text=${encodeURIComponent(`${process.env.clientId}: Exitting as-\nProcessId:${prcessID}\nMongo-${UserDataDtoCrud.getInstance()?.isConnected}\nTGClient-${tgClass.getClient()?.connected}\nRetryCount: ${retryTime}`)}`);
        }
        if (retryTime > 5) {
            console.log("Exitiing");
            await fetchWithTimeout(`${ppplbot()}&text=${(process.env.promoteClientId).toUpperCase()}:UNABLE TO START at RETRY - EXITTING\n\nPid:${process.pid}\n\nenv: ${process.env.promoteClientId}`);
            process.exit(1);
        }
        if (false && !process.env.repl?.includes("glitch")) {
            const resp = await fetchWithTimeout(`${process.env.repl}/getProcessId`, { timeout: 100000 });
            try {
                console.log(resp);
                const data = await resp.data;
                if (parseInt(data.ProcessId) === prcessID) {
                    console.log('Sending Req to Check Health: ', `${process.env.promoteChecker}/promoteconnect/${prcessID}?clientId=${process.env.clientId}`)
                    const respon = await fetchWithTimeout(`${process.env.promoteChecker}/promoteconnect/${prcessID}?clientId=${process.env.clientId}`);
                    if (!respon.data) {
                        console.log("EXITTING")
                        process.exit(1);
                    }
                } else {
                    console.log("EXITTING")
                    process.exit(1);
                }
            } catch (error) {
                console.log('Cannot fetch pinger', error);
            }
        } else {
            const respon = await fetchWithTimeout(`${process.env.promoteChecker}/promoteconnect/${prcessID}?clientId=${process.env.promoteClientId}`);
            if (!respon.data) {
                console.log("EXITTING")
                process.exit(1);
            }
        }
    }
    sendPing = false;
}