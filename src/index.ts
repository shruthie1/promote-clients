require('dotenv').config()
console.log("in Config");
import { execSync } from "child_process";
import fetch from "node-fetch";
import fs from 'fs'
import path from "path";


// Function to read package.json
const readPackageJson = () => {
    try {
        const packageJsonPath = path.resolve(__dirname, '../package.json');
        const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
        return JSON.parse(packageJsonContent);
    } catch (error) {
        console.error('Error reading package.json:', error.message);
        throw error;
    }
};

// Function to write package.json
const writePackageJson = (data) => {
    try {
        const packageJsonPath = path.resolve(__dirname, '../package.json');
        const packageJsonContent = JSON.stringify(data, null, 2);
        fs.writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');
    } catch (error) {
        console.error('Error writing package.json:', error.message);
        throw error;
    }
};

// Function to modify package.json
const modifyPackageJson = (action: string, packageName: string, version?: string, dev = false) => {
    let packageJson;
    try {
        packageJson = readPackageJson();
    } catch (error) {
        console.error('Failed to load package.json. Exiting...');
        return;
    }

    const section = dev ? 'devDependencies' : 'dependencies';

    switch (action) {
        case 'add':
            if (!version) {
                console.error('Version is required to add a package.');
                return;
            }
            if (!packageJson[section]) packageJson[section] = {};
            packageJson[section][packageName] = version;
            break;
        case 'remove':
            if (packageJson[section] && packageJson[section][packageName]) {
                delete packageJson[section][packageName];
            } else {
                console.error(`Package ${packageName} not found in ${section}.`);
                return;
            }
            break;
        case 'change':
            if (packageJson[section] && packageJson[section][packageName]) {
                if (!version) {
                    console.error('Version is required to change a package.');
                    return;
                }
                packageJson[section][packageName] = version;
            } else {
                console.error(`Package ${packageName} not found in ${section}.`);
                return;
            }
            break;
        default:
            console.error(`Unknown action: ${action}`);
            return;
    }

    try {
        writePackageJson(packageJson);
        console.log(`Package ${packageName} has been ${action}ed successfully!`);
    } catch (error) {
        console.error('Failed to update package.json.');
    }
};
// modifyPackageJson('add', 'lodash', '^4.17.21');
// modifyPackageJson('remove', 'lodash');
// modifyPackageJson('change', 'telegram', '^2.24.11');
// modifyPackageJson('add', 'cors', '^2.8.5');
// installPackage()

async function installPackage() {
    console.log(" executing npm i")
    execSync("npm i")
    // const installProcess = spawn('npm', ['install']);
    // installProcess.stdout.on('data', (data) => console.log(data.toString()));
    // installProcess.stderr.on('data', (data) => console.error(data.toString()));
    // await new Promise((resolve) => installProcess.on('close', resolve));
}

export async function getDataAndSetEnvVariables(url: string) {
    try {
        const response = await fetch(url);
        const jsonData: any = await response.json();
        for (const key in jsonData) {
            console.log("Setting Key", key)
            process.env[key] = jsonData[key];
        }
        console.log('Environment variables set successfully!');
    } catch (error) {
        console.error('Error retrieving data or setting environment variables:', error);
    }
}

async function setEnv() {
    // await getDataAndSetEnvVariables(`https://checker-production-c3c0.up.railway.app/forward/clients/${process.env.clientId}`);
    await getDataAndSetEnvVariables(`https://checker-production-c3c0.up.railway.app/forward/configuration`);
    console.log("Env Mobile : ", process.env.mobile)
    require('./express')
}

setEnv();


