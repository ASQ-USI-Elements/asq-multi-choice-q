var ASQPlugin = require('asq-plugin');
var ObjectId = require("bson-objectid");
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');




//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-multi-choice-q',

  hooks:{
    "parse_html" : "parseHtml",
    "answer_submission" : "answerSubmission",
    "presenter_connected" : "presenterConnected",
    "viewer_connected" : "viewerConnected"
  },

  events: {
    "plugin" : "onPlugin"
  },

  parseHtml: coroutine(function* parseHtmlGen(options){
    var $ = cheerio.load(options.html,  {
      decodeEntities: false,
      lowerCaseAttributeNames:false,
      lowerCaseTags:false,
      recognizeSelfClosing: true
    });
    var mcQuestions = [];

    var all = $(this.tagName).toArray();
    for ( var i in all) {
      var el = all[i];
      var question = yield this.processEl($, el);
      mcQuestions.push(question);
    }

    options.html = $.root().html();
    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(mcQuestions)
    .then(function(){
      
      return Promise.resolve(options);
    });
    
  }),

  copyAnswers : function(answer, question){
    for(var i = 0, l = answer.options.length; i<l; i++){
      for(var j = 0, l2 = question.data.options.length; j<l2; j++){
        if(answer.options[i].uid.toString()  == question.data.options[j].uid){
          question.data.options[j].sum = answer.options[i].sum;
          question.data.options[j].uid = question.data.options[j].uid;
          break;
        }
      }
    }
  },


  parseSettings: coroutine(function* parseSettingsGen($, el) {
    var $el = $(el);
    var attrs = $el.attr();

    var settings = this.asq.api.settings.defaultSettings['question'];

    for ( var i in settings ) {
      if ( attrs.hasOwnProperty(settings[i].key) ) {
        // validation ?
        settings[i].value = attrs[settings[i].key];
      } 
      else {
        this.writeSettingAsAttribute($el, settings[i]);
      }
    }

    // settings = yield this.createSettings(settings); 
    return settings
  }),

  writeSettingAsAttribute: function($el, setting) {
    // boolean
    $el.attr(setting.key, setting.value);
  },

  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $unwind: "$submission" },
      { $project : {  "submitDate":1,
                      "submission._id" : "$submission._id",
                      "submission.num" : { $cond : [ "$submission.value", 1, 0 ] } 
        }
      },
      { $group:{
          "_id":{
            "question" : "$_id.question",
            "option_id": "$submission._id"
          },
          "sum":{$sum: "$submission.num"},
          "submitDate":{$first: "$submitDate"},
          "submission": {$first: "$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "options":{$push: {"uid" : "$_id.option_id" , "sum": "$sum"}}
        }
      },
      { $project : { 
          "_id": 0,
          "question" : "$_id.question",
          "options" : 1
        } 
      }
    ]

    var answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();
    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.data.options.forEach(function(opt){
        opt.uid = opt._id.toString();
        delete opt._id;
      });
      for(var i=0, l=answers.length; i<l; i++){
        if(answers[i].question.toString() == q._id){
          this.copyAnswers(answers[i], q);
          break;
        }
      }
    }.bind(this));

    return questions;    
  }),

  countAnswers : coroutine(function *countAnswersGen(session_id, presentation_id){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });
    var pipeline = [
      { $match: {
          "session": session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $group: { _id: null, count: { $sum: 1 } } },
      { $project : { 
          "_id": 0,
          "count" : 1
        } 
      }
    ]

    var total = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var count = 0;
    if ( total.length ) {
      count = total[0].count;
    }

    return count;
  }),

  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithScores = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var total = 0;

    if(questionsWithScores.length){
      total = yield this.countAnswers(info.session_id, info.presentation_id);
    }

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithScores,
      total:total
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){

    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "answeree" : whitelistId,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id": "$question",
          "options": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "question" : "$_id",
          "options": 1,
        }
      }
    ];
    var answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    questions.forEach( q => {
      q.uid = q._id.toString();

      // cache data
      const questionData = q.data;
      // reset q.data so that we just send the information that's needed
      q.data = {};


      for(let i=0, l=answers.length; i<l; i++){
        if(answers[i].question.toString() == q._id){
          q.ownAnswer = answers[i];
          answers[i].options.forEach(function(opt){
            opt.uid = opt._id.toString();
            delete opt._id;
          });
          answers[i].isSubmissionCorrect = this.doOptionsMatch(q.data.options, answers[i].options);

          if(questionData.solution && !correct && questionData.hint){
            q.data.hint = questionData.hint;
          }

          break;
        }
      }
    });

    // answers.forEach( qa => {
    //   qa.options.forEach(function(opt){
    //     opt.uid = opt._id.toString();
    //     delete opt._id;
    //   });
    //   questions.forEach( q => {
    //     if(q._id.toString() !== qa.uid.toString()) return;
    //     qa.isSubmissionCorrect = this.doOptionsMatch(q.data.options, qa.options)
    //   });
    // });

    return questions;    
  }),
  
  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    // this will be the argument to the next hook
    return info;
  }),

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-multi-choice-q question
    if(question.type !== this.tagName) {
      return answer;
    }

    // make sure options are valid
    var options = answer.options
    assert(_.isArray(options),
      'Invalid answer format, answer.submission should be an array.');

    var sanitized = [];
    var sOptionUids = options.map(function optionMap(option){
      //sanitize
      var option = _.pick(option, 'uid', 'value');
       assert(ObjectId.isValid(option.uid),
        'Invalid answer format, option should have a uid property');

      sanitized.push({_id: ObjectId(option.uid), value: option.value})

      return option.uid;
    });

    var qOptionUids = question.data.options.map(function optionMap2(option){
      return option._id.toString();
    })

    //check if the arrays have the same elements
    assert(_.isEmpty(_.xor(qOptionUids, sOptionUids)),
      'Invalid answer, submitted option uids do not match those in the database');

    answer.submission = sanitized;

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      type       : question.type,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    this.calculateProgress(answer.session, ObjectId(questionUid));

    this.sendFeedbackToAnsweree(question, answer);

    //this will be the argument to the next hook
    return answer;
  }),

  doOptionsMatch: function(qOpts, aOpts){
    // go over question and answer options
    // if their ids match then we check if the correct
    // property of the question option is equal to the value (true | false)
    // of the answer option
    for (let i = 0; i < qOpts.length; i++ ){
      const qo = qOpts[i];
      for (let j = 0; j < aOpts.length; j++ ){
        const ao = aOpts[j];
        if(qo._id.toString() !== ao.uid.toString()) continue;
        if(qo.correct !== ao.value){
          return false;
        }
      };
    };
    return true;
  },

  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var pipeline = [
      { $match: {
          "session": session_id,
          "question" : question_id
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $unwind: "$submission" },
      { $project : {  "submitDate":1,
                      "submission._id" : "$submission._id",
                      "submission.num" : { $cond : [ "$submission.value", 1, 0 ] } 
        }
      },
      { $group:{
          "_id":{
            "question" : "$_id.question",
            "option_id": "$submission._id"
          },
          "sum":{$sum: "$submission.num"},
          "submitDate":{$first: "$submitDate"},
          "submission": {$first: "$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "options":{$push: {"uid" : "$_id.option_id" , "sum": "$sum"}}
        }
      },
      { $project : { 
          "_id": 0,
          "question" : "$_id.question",
          "options" : 1
        } 
      }
    ]

    var answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var pipeline2 = [
      { $match: {
          "session": session_id,
          "question" : question_id
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $group: { _id: null, count: { $sum: 1 } } },
      { $project : { 
          "_id": 0,
          "count" : 1
        } 
      }
    ]

    var total = yield this.asq.db.model('Answer').aggregate(pipeline2).exec();

    var count = 0;
    if ( total.length ) {
      total = total[0].count;
    }

    var event = {
      questionType: this.tagName,
      type: 'progress',
      question: answers[0],
      total: total
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'ctrl')
  }),

  sendFeedbackToAnsweree: function(question, userAnswer){
    if(! userAnswer.socketId) return;

    const isSubmissionCorrect = this.doOptionsMatch(question.data.options, userAnswer.options);

    let event = {
      questionType: this.tagName,
      type: 'self-progress',
      question:{
        uid: question.id,
        data:{},
        answer: {
          submission: userAnswer.options,
          isSubmissionCorrect
        },
      }
    }

    if(!isSubmissionCorrect && question.data.hint){
      event.question.data.hint = question.data.hint;
    }

    this.asq.socket.emit('asq:question_type', event, userAnswer.socketId);
  },

  processEl: coroutine(function* processElGen($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    //parse options
    var options = this.parseOptions($, el);

    var settings = yield this.parseSettings($, el);

    const result =  {
      _id : uid,
      type: this.tagName,
      data: {
        html: $.html($el),
        stem: stem,
        options: options
      },
      settings: settings
    };

    //parse hint
    const hint = this.parseHint($, el);

    if(hint){
      result.data.hint = hint;
    }

    return result;

  }),

  parseOptions: function($, el){
   
    var dbOptions = [];
    var ids = Object.create(null);
    var $el = $(el);

    var $asqOptions = $el.find('asq-option');
    assert($asqOptions.length > 1
      , 'A multi-choice question should have at least two `asq-option` children' )

    $asqOptions.each(function(idx, option){
      $option = $(option);


      //make sure optiosn are id'ed
      var uid = $option.attr('uid');
      if(uid == undefined || uid.trim() == ''){
        $option.attr('uid', uid = ObjectId().toString() );
      } 

      assert(!ids[uid]
        , 'A multi-choice question cannot have two `asq-option` elements with the same uids' );
     
      ids[uid] = true;

      //check if the options is marked as a correct choice
      var correct = getBooleanValOfBooleanAttr("correct", $option.attr('correct'));

      //remove correct Attr so that it doesn't get served in HTML
      $option.removeAttr('correct');
      dbOptions.push({
        _id : ObjectId(uid),
        html: $option.html(),
        correct : correct
      });
    });

    return dbOptions;
  },

  parseHint: function($, el){
    let $el = $(el);

    let hint = null;
    let $hint = $el.find('asq-hint').eq(0);
    if($hint){
      hint = $hint.html();
    }  

    //remove all hint elements so that they don't get served in HTML
    $el.find('asq-hint').remove();
    
    return hint;
  },

  onPlugin: function(evt){
    if(! evt.sessionId || evt.questionType !== this.tagName) return;

    switch(evt.type){
      case 'quiztimedout' :
        this.quizTimedOut(evt)
        break;
    }
  },

  quizTimedOut: coroutine(function *quizTimedOutGen (evt){

    const questionUid = evt.questionUid
    let question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an asq-multi-chocie-q question
    if(question.type !== this.tagName) {
      return;
    }

    let responseEvent = {
     questionType: this.tagName,
     type: 'show-hint-quiztimedout',
     question:{
       uid: question.id,
       data:{},
      }
    };

    if(question.data.hint){
     responseEvent.question.data.hint = question.data.hint;
    }

    this.asq.socket.emit('asq:question_type', responseEvent, evt.socketId);
  }),
});