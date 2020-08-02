const amqplib = require("amqplib");

const request = require("request")

require("dotenv").config();

let channel = null;

const QUEUE = "maxfield-task";

const express = require("express");
const bodyParser = require("body-parser");
const fileUpload = require("express-fileupload");

const redis = require("redis");
const redis_client = redis.createClient({
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASS,
});

const Recaptcha = require("express-recaptcha").RecaptchaV3;

const recaptcha = new Recaptcha(
  process.env.RECAP_SITEKEY,
  process.env.RECAP_SECRETKEY
);

var nodelist = [];

const app = express();

app.use(express.static("data"));

const AMQPInfo = process.env.AMQPURL.match(/^amqp:\/\/(.+):(.+)@(.+)\/(.+)$/);

const { body, validationResult } = require("express-validator");

app.all("*", function (req, res, next) {
  res.header("Access-Control-Allow-Origin", process.env.ORIGIN);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Content-Length, Authorization, Accept, X-Requested-With"
  );
  res.header("Access-Control-Allow-Methods", "PUT, POST, GET, DELETE, OPTIONS");
  if (req.method == "OPTIONS") {
    res.send(200);
  } else {
    next();
  }
});

app.use(bodyParser());
app.use(fileUpload());

app.get("/", (req, res) => res.send("It works!"));

app.get("/queue", [], (req, res) => {
  channel.assertQueue(QUEUE).then((info) => {
    res.send({
      error: false,
      inqueue: info.messageCount,
      worker: nodelist.length,
    });
  });
});

app.get("/stats", [], (req, res) => {
  redis_client
    .multi()
    .get("status.submits")
    .get("status.success")
    .exec(function (errors, results) {
      res.send({
        error: false,
        submits: results[0],
        success: results[1],
        nodes: nodelist,
      });
    });
});

app.post("/status", [], (req, res) => {
  var created_list = [];
  req.body.tasks.forEach((el) => {
    created_list.push(el + ".created");
  });
  redis_client
    .multi()
    .mget(req.body.tasks)
    .mget(created_list)
    .exec(function (errors, results) {
      res.send({
        error: false,
        data: results[0],
        expire: results[1],
      });
    });
});

app.post("/submit", recaptcha.middleware.verify, (req, res) => {
  body("agents").isInt();
  body("googlemap").isBoolean();
  body("faction").isIn(["res", "enl"]);
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res
      .status(422)
      .json({ error: true, desc: "FIELD", errors: errors.array() });
  }
  if (req.recaptcha.error) {
    return res.send({ error: true, desc: "CAPTCHA" });
  }

  var id = randomid();
  channel.assertQueue(QUEUE).then((info) => {
    channel.sendToQueue(
      QUEUE,
      Buffer.from(
        JSON.stringify({
          agents: req.body.agents,
          googlemap: req.body.googlemap,
          portal: req.body.portals,
          faction: req.body.faction,
        })
      ),
      {
        correlationId: id.taskid,
        replyTo: "amq.rabbitmq.reply-to",
      }
    );
    res.send({ error: false, submitid: id.taskid, inqueue: info.messageCount });
  });
  redis_client.incr("status.submits");
});

function refreshWorkers() {
  var options = {
    auth: {
      user: AMQPInfo[1],
      pass: AMQPInfo[2],
    },
  };
  var req = request.get(
    "https://" + AMQPInfo[3] + "/api/consumers",
    options,
    function (err, res, data) {
      nodelist = []
      var datajson = JSON.parse(data);
      datajson.forEach((el) => {
        var nodeinfo = el.consumer_tag.split(":");
        nodelist.push({
          name: nodeinfo[0],
          cores: nodeinfo[1],
        });
      });
      console.log("Worker Refreshed.")
    }
  );
}

function getReply(msg) {
  var reply_msg = JSON.parse(msg.content.toString());
  var status = reply_msg.node;
  if (status.endsWith(".processing")) {
    redis_client.set(msg.properties.correlationId, status);
  } else {
    if (reply_msg.status == false) {
      status = "FAILED";
    } else {
      redis_client.set(
        msg.properties.correlationId + ".created",
        new Date().getTime()
      );
      redis_client.expire(msg.properties.correlationId + ".created", 86400);
      redis_client.incr("status.success");
    }
    redis_client.set(msg.properties.correlationId, status);
    redis_client.expire(msg.properties.correlationId, 86400);
  }
}

function init() {
  return require("amqplib")
    .connect(process.env.AMQPURL)
    .then((conn) => conn.createChannel())
    .then((ch) => {
      channel = ch;
      ch.consume("amq.rabbitmq.reply-to", getReply, { noAck: true });
    });
}

function randomid() {
  var ret1 = new Date().getTime();
  var ret2 = Math.random();
  var ret3 = Math.random();
  return {
    //uuid: ret1.toString() + ret2.toString() + ret3.toString(),
    taskid: ret1.toString(16) + ret2.toString(16) + ret3.toString(16),
  };
}

refreshWorkers()

setInterval(refreshWorkers, 30000);

init()
  .then(() =>
    app.listen(process.env.PORT, () =>
      console.log("MaxField API running on port " + process.env.PORT + " !")
    )
  )
  .catch((err) => console.error(err));
