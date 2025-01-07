import { fetchWithTimeout } from "./fetchWithTimeout";
import { ppplbot, startNewUserProcess } from "./utils";
const notifbot = `https://api.telegram.org/bot5856546982:AAEW5QCbfb7nFAcmsTyVjHXyV86TVVLcL_g/sendMessage?chat_id=-1001823103248`

export function parseError(
  err: any = { message: "UNKNOWN", errorMessage: "unk" },
  prefix: string,
  sendErr: boolean = true
) {
  let status = 'UNKNOWN';
  let message = 'An unknown error occurred';
  let error = 'UnknownError';
  prefix = `${process.env.clientId}-PROM: ${prefix ? prefix : ""}`

  const extractMessage = (data: any): string => {
    if (Array.isArray(data)) {
      const messages = data.map((item) => extractMessage(item));
      return messages.filter((message) => message !== undefined).join(', ');
    } else if (typeof data === 'string') {
      return data;
    } else if (typeof data === 'object' && data !== null) {
      for (const key in data) {
        if (
          Array.isArray(data[key]) &&
          data[key].every((item) => typeof item === 'string')
        ) {
          return data[key].join(', ');
        } else if (typeof data[key] === 'object' && data[key] !== null) {
          const nestedMessage = extractMessage(data[key]);
          if (nestedMessage !== undefined) {
            return nestedMessage;
          }
        } else {
          return JSON.stringify(data[key]);
        }
      }
    }
    return JSON.stringify(data);
  };

  if (err?.response) {
    const response = err.response;
    status =
      response.data?.status ||
      response.status ||
      err.status ||
      'UNKNOWN';
    message =
      response.data?.message ||
      response.data?.errors ||
      response.errorMessage ||
      response.message ||
      response.statusText ||
      response.data ||
      err.message ||
      'An error occurred';
    error =
      response.data?.error ||
      response.error ||
      err.name ||
      err.code ||
      'Error';
  } else if (err?.request) {
    status = err.status || 'NO_RESPONSE';
    message = err.data?.message ||
      err.data?.errors ||
      err.message ||
      err.statusText ||
      err.data ||
      err.message || 'The request was triggered but no response was received';
    error = err.name || err.code || 'NoResponseError';
  } else if (err?.message) {
    status = err.status || 'UNKNOWN';
    message = err.message;
    error = err.name || err.code || 'Error';
  } else if (err?.errorMessage) {
    status = err.status || 'UNKNOWN';
    message = err.errorMessage;
    error = err.name || err.code || 'Error';
  }
  // console.log(err)
  const msg = `${prefix ? `${prefix} ::` : ""} ${extractMessage(message)} `
  const resp = { status, message: err.errorMessage || msg, error };
  console.log(resp.error == 'RPCError' ? resp.message : resp);
  console.log(resp);
  if ((sendErr && !msg.includes("INPUT_USER_DEACTIVATED")) ||
    ((msg.includes("USER_DEACTIVATED") || msg.includes("USER_DEACTIVATED_BAN")) && !msg.includes("INPUT_USER_DEACTIVATED"))) {
    fetchWithTimeout(`${ppplbot(process.env.notifChannel)}&text=${resp.message}`);
  }
  return resp
}