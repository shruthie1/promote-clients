import axios, { AddressFamily, AxiosRequestConfig } from "axios";
import { parseError } from "./parseError";
import { ppplbot } from "./utils";

export async function fetchWithTimeout(resource: string, options: AxiosRequestConfig = {}, sendErr: boolean = true, maxRetries: number = 1) {
    options.timeout = options.timeout || 50000;
    options.method = options.method || 'GET';

    const fetchWithProtocol = async (url: string, version: AddressFamily) => {
        const source = axios.CancelToken.source();
        const id = setTimeout(() => {
            source.cancel(`Request timed out after ${options.timeout}ms`);
        }, options.timeout);
        const defaultHeaders = {
            'Content-Type': 'application/json'
        };
        const headers = { ...defaultHeaders, ...options.headers };
        try {
            const response = await axios({
                headers,
                ...options,
                url,
                cancelToken: source.token,
                family: version
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            console.log(`Error at URL (IPv${version}): `, url);
            if (axios.isCancel(error)) {
                console.log('Request canceled:', error.message, url);
                return undefined;
            }
            throw error; // Rethrow the error to handle retry logic outside
        }
    };

    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        try {
            const responseIPv4 = await fetchWithProtocol(resource, 4);
            if (responseIPv4) return responseIPv4;
            const responseIPv6 = await fetchWithProtocol(resource, 6);
            if (responseIPv6) return responseIPv6;
        } catch (error: any) {
            console.log("Error at URL : ", resource)
            const errorDetails = parseError(error, undefined, false)
            if (errorDetails.status.toString() !== '429' && error.code !== 'ERR_NETWORK' && error.code !== "ECONNABORTED" && error.code !== "ETIMEDOUT" && !errorDetails.message.toLowerCase().includes('too many requests') && !axios.isCancel(error)) {
                if (retryCount < maxRetries) {
                    console.log(`Retrying... (${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds delay
                } else {
                    console.log(`All ${maxRetries + 1} retries failed for ${resource}`);
                    if (sendErr) {
                        axios.get(`${ppplbot()}&text=${encodeURIComponent(`${process.env.clientId}-Prom :: All ${maxRetries + 1} retries failed for ${resource}\n${errorDetails.message}`)}`)
                    }
                    return undefined;
                }
            }
        }
    }
}
