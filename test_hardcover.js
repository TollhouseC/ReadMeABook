const axios = require('axios');
async function run() {
  try {
    const res = await axios.post('https://api.hardcover.app/v1/graphql', {
      query: "{ __schema { types { name } } }"
    });
    console.log(res.data);
  } catch(e) {
    console.log(e.response ? e.response.data : e.message);
  }
}
run();
