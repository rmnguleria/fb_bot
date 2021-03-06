/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  mongoose = require('mongoose');

//connect to our database
mongoose.connect("mongodb://localhost:27017/fbbot");

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

var UserInfo = require('./models/userinfo');
/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    console.log(req.query['hub.verify_token']);
    console.log('Actual Token',VALIDATION_TOKEN);
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;
  console.log()
  console.log('req body',data);
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {
        sendTextMessage(senderID, messageText);
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful
  sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  
  messageText = plagiarizeRequest(messageText);
  console.log('messagetext',messageText);
  
  var headers = {
    'Host': 'kakko.pandorabots.com',
    'Connection': 'keep-alive',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  var cust_id = "cust_id";
  UserInfo.find({fb_id : recipientId},function(err,user){
    console.log('Inside find fnctn');
    if(err){
      console.log('err',err);
    }else{
      console.log('user',user[0]);
      if(user[0] != undefined){
        console.log('Found the customer in db');
        cust_id = user[0].cust_id;
      }
      console.log('cust_id',cust_id);
      var dataString = 'input='+encodeURI(messageText)+'&botid=9fa364f2fe345a10';
      if(cust_id != "cust_id"){
        dataString += '&custid='+cust_id;
      }

  console.log('dataString',dataString);

  var options = {
      url: 'https://kakko.pandorabots.com/pandora/talk-xml',
      method: 'POST',
      headers: headers,
      body: dataString
  };

  function callback(error, response, body) {
      console.log('response',body);
      if (!error && response.statusCode == 200) {
          var start = body.indexOf('<that>')+6;
          var end = body.indexOf('</that>');
          if(cust_id == 'cust_id'){
            saveID(recipientId,body);
          }
          var responseMessage = body.substring(start,end);
          responseMessage = handleParsing(responseMessage);
          responseMessage = plagiarizeResponse(responseMessage);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {
              text: responseMessage
            }
          };
          callSendAPI(messageData);
      }
  }

  request(options, callback);
    }
  });
}

function plagiarizeRequest(messageText){
  messageText = messageText.replace(/[kK]eiko/g,'Mitsuku');
  messageText = messageText.replace(/[iI]nsurgentes/g,'Mousebreaker');

  return messageText;
}

function saveID(recipientId,body){
  console.log('inside saveId function');
  var start = body.indexOf('custid="')+8;
  var end = body.indexOf('">');
  var custid = body.substring(start,end);
  console.log('custid',custid);

  var user = new UserInfo({
    fb_id : recipientId,
    cust_id : custid
  });
  user.save(function(err,user){
    if(err){
      console.log(err);
    }
  });
}

function handleParsing(responseMessage){
  // 640 limit set by fb messenger
  if(responseMessage.length > 640){
    var end = responseMessage.lastIndexOf('.',640);
    responseMessage = responseMessage.substring(0,end);
  }
  // handle quotes
  responseMessage = responseMessage.replace(/&quot;/g,'"');

  var xlinkStart = responseMessage.indexOf('xlink')
  var xlinkEnd = responseMessage.lastIndexOf('xlink');
  if(xlinkEnd != -1){
    responseMessage = responseMessage.replace(responseMessage.substring(xlinkStart,xlinkEnd+5),'');
  }

  //remove xgallerylinks
  var xgalleryStart = responseMessage.indexOf('xgallery')
  var xgalleryEnd = responseMessage.lastIndexOf('xgallery');
  if(xgalleryEnd != -1){
    responseMessage = responseMessage.replace(responseMessage.substring(xgalleryStart,xgalleryEnd+8),'');
  }

    //remove xnslinks
  var xnsLinkStart = responseMessage.indexOf('xnslink')
  var xnsLinkEnd = responseMessage.lastIndexOf('xnslink');
  if(xnsLinkEnd != -1){
    responseMessage = responseMessage.replace(responseMessage.substring(xnsLinkStart,xnsLinkEnd+7),'');
  }

  //remove xloadwf
  var xloadswfStart = responseMessage.indexOf('xloadswf')
  var xloadswfEnd = responseMessage.lastIndexOf('xloadswf');
  if(xloadswfEnd != -1){
    responseMessage = responseMessage.replace(responseMessage.substring(xloadswfStart,xloadswfEnd+8),'');
  }

  // handle other tags.
  var imStart = responseMessage.indexOf('&lt;P');
  var imEnd = responseMessage.lastIndexOf('P&gt;');
  if(imEnd != -1){
    responseMessage = responseMessage.replace(responseMessage.substring(imStart,imEnd+5),'');
  }

  responseMessage = responseMessage.replace(/&lt;br&gt;/g,'');
  // handle images
  console.log('handleParsingResponse',responseMessage);
  return responseMessage;

}

function plagiarizeResponse(responseMessage){
    if(responseMessage.includes('Mousebreaker is a team of 2 flash programmers. They write games and put them on websites such as this. They both support Leeds United and like beer and curry. On Wednesdays they go to the zoo and feed wild animals. They are scared of Daleks. Mousebreaker was born in a stable in Yorkshire, England and now lives in Leeds, England.')){
          responseMessage = 'Insurgentes is a team of 2 programmers from the future waiting for you to join us build it together.'
    }
    responseMessage = responseMessage.replace(/[mM]ousebreaker/g,'Insurgentes');     
    responseMessage = responseMessage.replace(/[mM]itsuku/g,'Keiko');

    console.log('plagiarizeResponse',responseMessage);
    return responseMessage;
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

