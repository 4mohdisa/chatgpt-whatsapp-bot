const http = require('http');
const express = require('express');
const session = require('express-session');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const { Configuration, OpenAIApi } = require("openai");
const dotenv = require('dotenv');
const axios = require("axios");
//let mysql = require('mysql');
dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({ secret: 'anything-you-want-but-keep-secret' }));



const configuration = new Configuration({
    organization: process.env.OPENAI_ORGRANIZATION,
    apiKey: process.env.OPENAI_API_KEY,
});


const openai = new OpenAIApi(configuration);

app.get( '/', (req,res) => {
    res.send("Running............");
} )


app.post('/sms', async (req, res) => {
    const smsCount = req.session.counter || 0;

    const number = req.body.From.substring(9, req.body.From.length);
  
    let data = await axios.get(process.env.SUBSCRIPTION_API_URL + "/" + number);
    
    data = data.data.data;


   
    
    let subscription;

    console.log(data);

    if (data.subscription.length != 0) {


        subscription = data.subscription[0].sub
    }else if (data.subscription.length == 0) {
        
        subscription = -1;
    }
    

    let message;

    if (subscription == 0) {
        message = "You dont have an active subscription. Please visit our website to view our plans"
    }else if (subscription == -1) {
        
        //console.log(isNaN(req.body.Body))
        if ( isNaN(req.body.Body) == false) {
            
            message = "Tokens are selected"
            
            axios.post(process.env.SUBSCRIPTION_API_URL, {
                "contact_no": number,
                "sub": '7',
                "tokens":req.body.Body
              });
            
        }else {

            message = "Please give me your required tokens"
        }

        
    }
     else {
        //console.log(subscription + "in else block")
        const completion = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: req.body.Body,
            temperature: 0,
            max_tokens: parseInt(data.subscription[0].tokens)
        });
    
    
        //console.log()
        message = completion.data.choices[0].text;
    }
    
    req.session.counter = smsCount + 1;

    const twiml = new MessagingResponse();
    twiml.message(message);

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});
//console.log('The solution is: ', results[0]);

//connection.end();


http.createServer(app).listen(process.env.PORT || 3000, () => {
    console.log('Express server listening on port 3000');
});
