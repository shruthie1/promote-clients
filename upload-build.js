const cloudinary = require('cloudinary');
const fetch = require('node-fetch');
async function overwriteFile(branch) {
  const localFilePath = `./out/index.js`; // Assuming the file is in the 'src' directory

  console.log("CL Name : ", process.env.CL_NAME);
  console.log("CL KEY : ", process.env.CL_APIKEY);

  cloudinary.v2.config({
    cloud_name: process.env.CL_NAME,
    api_key: process.env.CL_APIKEY,
    api_secret: process.env.CL_APISECRET
  });
  try {
    const result = await cloudinary.v2.uploader.upload(localFilePath, {
      resource_type: 'auto',
      overwrite: true,
      invalidate: true,
      public_id: `index-pmc-${branch}.js`
    });
    console.log(result);

    const url = `https://uptimechecker2.glitch.me/builds`;
    const bodyData = {};
    bodyData[`promotion-clients-new-3-3`] = `https://res.cloudinary.com/${process.env.CL_NAME}/raw/upload/v${result.version}/${result.public_id}`;

    const resp = await fetch(url, {
      method: 'PATCH',
      body: JSON.stringify(bodyData), // Make sure to stringify the body data
      headers: {
        'Content-Type': 'application/json', // Set the content type header for JSON data
      },
    });

  } catch (error) {
    console.log(error);
  }
}
const branchName = process.argv[2];
overwriteFile(branchName);