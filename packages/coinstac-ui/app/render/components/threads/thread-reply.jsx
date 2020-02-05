import React, { Component, Fragment } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { graphql, compose } from 'react-apollo'
import classNames from 'classnames'
import { omit } from 'lodash'
import {
  CircularProgress,
  FormControl,
  InputBase,
  InputLabel,
  MenuItem,
  Select,
  Tooltip,
} from '@material-ui/core'
import { withStyles } from '@material-ui/core/styles'
import ThreadAvatar from './thread-avatar'
import CustomSelect from '../common/react-select'
import {
  getAllAndSubProp,
} from '../../state/graphql/props'
import {
  FETCH_ALL_USERS_QUERY,
  FETCH_ALL_CONSORTIA_QUERY,
  USER_CHANGED_SUBSCRIPTION,
  CONSORTIUM_CHANGED_SUBSCRIPTION,
} from '../../state/graphql/functions'

const BootstrapInput = withStyles(theme => ({
  root: {
    'label + &': {
      marginTop: theme.spacing.unit * 3,
    },
  },
  input: {
    borderRadius: 4,
    position: 'relative',
    backgroundColor: theme.palette.background.paper,
    border: '1px solid #ced4da',
    fontSize: 16,
    padding: '10px 26px 10px 12px',
    transition: theme.transitions.create(['border-color', 'box-shadow']),

    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
      '"Apple Color Emoji"',
      '"Segoe UI Emoji"',
      '"Segoe UI Symbol"',
    ].join(','),
    '&:focus': {
      borderRadius: 4,
      borderColor: '#80bdff',
      boxShadow: '0 0 0 0.2rem rgba(0,123,255,.25)',
    },
  },
}))(InputBase)

const styles = theme => ({
  wrapper: {
    borderTop: `1px solid ${theme.palette.grey[300]}`,
    padding: theme.spacing.unit * 2,
  },
  recipients: {
    paddingLeft: theme.spacing.unit * 2,
    display: 'flex',
    alignItems: 'center',
    width: 300,
  },
  select: {
    paddingLeft: theme.spacing.unit,
  },
  textarea: {
    margin: `${theme.spacing.unit * 2}px 0`,
    padding: theme.spacing.unit * 2,
    fontSize: 16,
    width: '100%',
    height: 100,
    borderColor: theme.palette.grey[300],
    borderStyle: 'solid',
    borderWidth: '1px 0 1px 0',
    resize: 'none',
    '&:active, &:focus': {
      outline: 'none',
    }
  },
  actionWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  formControl: {
    marginRight: theme.spacing.unit,
  },
  replyButton: {
    width: 100,
    padding: `${theme.spacing.unit}px 0`,
    backgroundColor: '#0078d4',
    fontSize: 14,
    color: 'white',
    cursor: 'pointer',
    border: 0,
    outline: 'none',
    '&:hover': {
      backgroundColor: '#005a9e',
    },
    '&.disabled': {
      backgroundColor: `${theme.palette.grey[300]} !important`,
      cursor: 'not-allowed',
    },
  },
  loader: {
    width: `20px !important`,
    height: `20px !important`,
    marginRight: 10,
  }
})

const INITIAL_STATE = {
  threadId: '',
  title: '',
  selectedRecipients: [],
  message: '',
  action: 'none',
  selectedConsortium: 'none',
  selectedResult: 'none',
}

class ThreadReply extends Component {
  constructor(props) {
    super(props)

    this.state = INITIAL_STATE
  }

  UNSAFE_componentWillMount() {
    this.initializeState(this.props);
  }

  UNSAFE_componentWillReceiveProps(nextProps) {
    const { title, savingStatus } = this.props

    if (savingStatus !== nextProps.savingStatus) {
      this.setState(omit(INITIAL_STATE, ['threadId', 'title']))
    } else if (title !== nextProps.title) {
      this.initializeState(nextProps)
    }
  }

  initializeState = props => {
    const { threadId, title } = props

    this.setState({
      threadId: threadId || '',
      title: title || '',
    })
  }

  handleRecipientsChange = selectedRecipients => {
    this.setState({ selectedRecipients })
  }

  handleMessageChange = evt => {
    this.setState({ message: evt.target.value })
  }

  handleActionChange = evt => {
    const { value } = evt.target
    this.setState(Object.assign(
      { action: value },
      value === 'none' && { selectedConsortium: 'none' },
    ))
  }

  handleConsortiumChange = evt => {
    this.setState({ selectedConsortium: evt.target.value })
  }

  handleResultChange = evt => {
    this.setState({ selectedResult: evt.target.value })
  }

  handleSend = () => {
    const { consortia, savingStatus } = this.props
    const error = this.validateForm()

    if (savingStatus === 'pending' || error) {
      return
    }

    const {
      threadId,
      title,
      action,
      message,
      selectedRecipients,
      selectedConsortium,
      selectedResult,
    } = this.state

    const data = Object.assign(
      {
        threadId,
        title,
        recipients: selectedRecipients.map(recipient => recipient.value),
        content: message,
      },
      (action === 'join-consortium' && selectedConsortium !== 'none') && ({
        action: {
          id: selectedConsortium,
          consortiumName: consortia.find(({ id }) => id === selectedConsortium).name,
          name: action,
        }
      }),
      (action === 'share-result' && selectedResult !== 'none') && ({
        action: {
          id: selectedResult,
          name: action,
        }
      }),
    )

    this.props.onSend(data)
  }

  validateForm = () => {
    const {
      action,
      title,
      message,
      selectedRecipients,
      selectedConsortium,
      selectedResult,
    } = this.state

    if (!title) {
      return 'Please input title'
    }

    if (selectedRecipients.length === 0) {
      return 'Please select at least one recipient'
    }

    if (!message) {
      return 'Please input your message'
    }

    if (action === 'join-consortium' && selectedConsortium === 'none') {
      return 'Please select consortium to join'
    }

    if (action === 'share-result' && selectedResult === 'none') {
      return 'Please select result to share'
    }

    return
  }

  renderReplyButton = () => {
    const { classes, savingStatus } = this.props
    const error = this.validateForm()

    const button = (
      <div className={classes.actionWrapper}>
        {savingStatus === 'pending' &&
          <CircularProgress color="secondary" className={classes.loader} />}
        <button
          className={
            classNames(
              classes.replyButton,
              { disabled: !!error || savingStatus === 'pending' },
            )
          }
          onClick={this.handleSend}
        >
          Send
        </button>
      </div>
    )

    if (error) {
      return (
        <Tooltip title={error || ''} placement="top">
          {button}    
        </Tooltip>
      )
    }

    return button
  }

  getAllRecipients = () => {
    const { users, currentUser } = this.props

    const allRecipients = (users || [])
      .filter(user => user.id !== currentUser.id)
      .map(user => ({ value: user.id, label: user.id }))

    return allRecipients
  }

  getAllConsortia = () => {
    const { consortia } = this.props

    let allConsortia = [
      { value: 'none', label: 'None' },
    ]

    consortia.forEach(consortium =>
      allConsortia.push({ value: consortium.id, label: consortium.name })
    )

    return allConsortia
  }

  getAllActions = () => {
    const allActions = [
      { value: 'none', label: 'None' },
      { value: 'join-consortium', label: 'Join Consortium' },
      { value: 'share-result', label: 'Share Result' },
    ]

    return allActions
  }

  getAllResults = () => {
    const { runs } = this.props

    let allRuns = [
      { value: 'none', label: 'None' },
    ]

    runs.forEach(run => {
      allRuns.push({ value: run.id, label: run.id })
    })

    return allRuns
  }

  render() {
    const { classes, currentUser } = this.props
    const {
      action,
      message,
      selectedRecipients,
      selectedConsortium,
      selectedResult,
    } = this.state

    return (
      <div className={classes.wrapper}>
        <div style={{ display: 'flex' }}>
          <ThreadAvatar username={currentUser.id} showUsername/>

          <div className={classes.recipients}>
            <span>To:</span>
            <CustomSelect
              value={selectedRecipients}
              placeholder="Select Recipients"
              options={this.getAllRecipients()}
              isMulti
              className={classes.select}
              style={{ height: 50 }}
              onChange={this.handleRecipientsChange}
            />
          </div>
        </div>

        <div>
          <textarea
            className={classes.textarea}
            value={message}
            placeholder='Your message here...'
            onChange={this.handleMessageChange}
          />
        </div>

        <div className={classes.actionWrapper}>
          <div>
            <FormControl className={classes.formControl}>
              <InputLabel>Action</InputLabel>
              <Select
                value={action}
                input={<BootstrapInput />}
                onChange={this.handleActionChange}
              >
                {this.getAllActions().map(action =>
                  <MenuItem
                    key={action.value}
                    value={action.value}
                  >
                    {action.label}
                  </MenuItem>
                )}
              </Select>
            </FormControl>

            {action === 'join-consortium' && (
              <FormControl className={classes.formControl}>
                <InputLabel>Consortium</InputLabel>
                <Select
                  value={selectedConsortium}
                  input={<BootstrapInput />}
                  onChange={this.handleConsortiumChange}
                >
                  {this.getAllConsortia().map(consortium =>
                    <MenuItem
                      key={consortium.value}
                      value={consortium.value}
                    >
                      {consortium.label}
                    </MenuItem>
                  )}
                </Select>
              </FormControl>
            )}

            {action === 'share-result' && (
              <FormControl className={classes.formControl}>
                <InputLabel>Result</InputLabel>
                <Select
                  value={selectedResult}
                  input={<BootstrapInput />}
                  onChange={this.handleResultChange}
                >
                  {this.getAllResults().map(result =>
                    <MenuItem
                      key={result.value}
                      value={result.value}
                    >
                      {result.label}
                    </MenuItem>
                  )}
                </Select>
              </FormControl>
            )}
          </div>

          {this.renderReplyButton()}
        </div>
      </div>
    )
  }
}

ThreadReply.propTypes = {
  classes: PropTypes.object.isRequired,
  currentUser: PropTypes.object.isRequired,
  users: PropTypes.array,
  threadId: PropTypes.any,
  title: PropTypes.any,
  savingStatus: PropTypes.string.isRequired,
  consortia: PropTypes.array,
  onSend: PropTypes.func.isRequired,
}

const selectors = ({ auth }) => ({
  currentUser: auth.user,
})

const ThreadReplyWithData = compose(
  graphql(FETCH_ALL_USERS_QUERY, getAllAndSubProp(
    USER_CHANGED_SUBSCRIPTION,
    'users',
    'fetchAllUsers',
    'subscribeToUsers',
    'userChanged'
  )),
  graphql(FETCH_ALL_CONSORTIA_QUERY, getAllAndSubProp(
    CONSORTIUM_CHANGED_SUBSCRIPTION,
    'consortia',
    'fetchAllConsortia',
    'subscribeToConsortia',
    'consortiumChanged'
  )),
)(ThreadReply)

const connectedComponent = connect(selectors)(ThreadReplyWithData)

export default withStyles(styles)(connectedComponent)
