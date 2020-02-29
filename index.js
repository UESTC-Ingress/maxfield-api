const amqplib = require("amqplib");

require("dotenv").config();

let channel = null;

const QUEUE = "maxfield-task";

const express = require("express");
const bodyParser = require("body-parser");
const fileUpload = require("express-fileupload");

const app = express();

const { check, validationResult } = require("express-validator");

app.all("*", function(req, res, next) {
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
  channel.assertQueue(QUEUE).then(info => {
    res.send({
      error: false,
      inqueue: info.messageCount,
      worker: info.consumerCount
    });
  });
});

app.post("/submit", [], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: true, errors: errors.array() });
  }

  var id = randomid();
  channel.assertQueue(QUEUE).then(info => {
    channel.sendToQueue(
      QUEUE,
      Buffer.from(
        JSON.stringify({
          agents: req.body.agents,
          googlemap: req.body.googlemap,
          portal: req.body.portals,
          faction: req.body.faction
        })
      ),
      {
        correlationId: id.uuid,
        replyTo: "amq.rabbitmq.reply-to"
      }
    );
    res.send({ error: false, submitid: id.taskid, inqueue: info.messageCount });
  });
});

function init() {
  return require("amqplib")
    .connect(process.env.AMQPURL)
    .then(conn => conn.createChannel())
    .then(ch => {
      channel = ch;
      ch.consume(
        "amq.rabbitmq.reply-to",
        msg => eventEmitter.emit(msg.properties.correlationId, msg.content),
        { noAck: true }
      );
    });
}

function randomid() {
  var ret1 = new Date().getTime();
  var ret2 = Math.random();
  var ret3 = Math.random();
  return {
    uuid: ret1.toString() + ret2.toString() + ret3.toString(),
    taskid: ret1.toString(16) + ret2.toString(16) + ret3.toString(16)
  };
}

init()
  .then(() =>
    app.listen(process.env.PORT, () =>
      console.log("MaxField API running on port " + process.env.PORT + " !")
    )
  )
  .catch(err => console.error(err));
